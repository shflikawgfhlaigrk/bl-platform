import { afterEach, describe, expect, it } from 'vitest';
import { asCoreDb, createTenant, createUser } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createLocation } from '@blacklabel/inventory';
import { createApp, type PlatformDatabase, type CreateAppOptions } from '../src/app';
import { stripeTerminalCheckoutProvider, stripeSignatureHeader } from '@blacklabel/orders';

const databases: Array<ReturnType<typeof createTestDb<PlatformDatabase>>> = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.destroy(); });
async function boot(options: Partial<CreateAppOptions> = {}) {
  const db = createTestDb<PlatformDatabase>(); databases.push(db);
  const platform = await createApp({ db, adminMasterKey: Buffer.alloc(32, 33), disableRateLimit: true, ...options });
  const tenant = await createTenant(asCoreDb(db), { name: 'Bar test' });
  await platform.seedTenant(tenant.id);
  const request = async (path: string, body?: unknown, opts: { key?: string; tenant?: string; user?: string; method?: string } = {}) => {
    const res = await platform.app.request(path.startsWith('/api/') ? path : `/api/pos/bar${path}`, {
      method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'x-tenant-id': opts.tenant ?? tenant.id, 'content-type': 'application/json',
        'x-mags-csrf': '1', 'idempotency-key': opts.key ?? crypto.randomUUID(), ...(opts.user ? { 'x-user-id': opts.user } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, ...await res.json() as any };
  };
  const location = await createLocation(db as never, tenant.id, 'system', { name: 'Bar', kind: 'warehouse' });
  expect((await request('/api/pos/settings', { taxBps: 825, defaultLocationId: location.id }, { method: 'PUT' })).status).toBe(200);
  const stock = await request('/stock', { name: 'Tequila', unit: 'ml', onHand: 1000, reason: 'Opening count' });
  expect(stock.status).toBe(200);
  const menu = await request('/menu', { name: 'Margarita', category: 'Cocktails', priceCents: 1001,
    recipe: [{ ingredientId: stock.data.id, quantity: 45 }], modifiers: [{ id: 'style', name: 'Style', required: true,
      choices: [{ id: 'classic', name: 'Classic', priceCents: 0 }, { id: 'double', name: 'Double', priceCents: 401,
        recipe: [{ ingredientId: stock.data.id, quantity: 45 }] }] }] });
  expect(menu.status).toBe(200);
  const tab = (await request('/tabs', { name: 'Patio 7', table: '7' })).data;
  const command = async (doc: any, cmd: unknown, opts = {}) => request(`/tabs/${doc.id}/commands`, { version: doc.version, ...cmd as any }, opts);
  const add = async (doc: any, quantity = 1) => command(doc, { action: 'add', menuId: menu.data.id,
    checkId: doc.value.checks[0].id, selections: { style: 'classic' }, quantity, seat: 2 });
  return { db, platform, tenant, request, stock: stock.data, menu: menu.data, tab, command, add };
}

describe('ONE Club bar acceptance', () => {
  it('starts a named walk-in bill with its item and upsells atomically and recovers without duplicates', async () => {
    const b = await boot();
    const water = (await b.request('/menu', { name: 'Water', category: 'No alcohol', priceCents: 150 })).data;
    const body = { name: 'Walk-in', billName: 'Michael', initialItems: [
      { menuId: b.menu.id, selections: { style: 'double' }, quantity: 2, seat: 3 }, { menuId: water.id, seat: 3 },
    ] };
    const first = await b.request('/tabs', body, { key: 'first-item-with-upsell' });
    expect(first.status).toBe(200);
    expect(first.data.value.items.map((i: any) => i.priceCents)).toEqual([1402, 1402, 150]);
    expect(first.data.value.items.every((i: any) => i.seat === 3)).toBe(true);
    expect(first.data.value.checks[0].name).toBe('Michael');
    const recovered = await b.request('/tabs', body, { key: 'first-item-with-upsell' });
    expect(recovered.data.id).toBe(first.data.id);
    expect((await b.request('/state')).data.tabs).toHaveLength(2);
    expect((await b.request('/state')).data.ingredients[0].value.onHand).toBe(1000);
    const invalid = await b.request('/tabs', { ...body, initialItems: [...body.initialItems, { menuId: 'missing-extra' }] });
    expect(invalid.status).toBe(404);
    expect((await b.request('/state')).data.tabs).toHaveLength(2);
    const failedUpdate = await b.command(first.data, { action: 'add', menuId: water.id, checkId: first.data.value.checks[0].id, extras: [{ menuId: 'missing-extra' }] });
    expect(failedUpdate.status).toBe(404);
    expect((await b.request('/state')).data.tabs.find((t: any) => t.id === first.data.id).value.items).toHaveLength(3);
  });
  it('saves draft items with explicitly pending tax, then prices them before service without losing or duplicating items', async () => {
    const b = await boot();
    await b.db.deleteFrom('api_config').where('tenant_id', '=', b.tenant.id).where('key', '=', 'pos_tax_bps').execute();
    let tab = (await b.add(b.tab, 3)).data;
    const read = async () => (await b.request('/state')).data.tabs.find((t: any) => t.id === tab.id);
    let viewed = await read();
    expect(viewed.taxPending).toBe(true);
    expect(viewed.value.checks[0]).toMatchObject({ taxPending: true, subtotalCents: 3003, taxCents: 0 });
    expect((await b.command(tab, { action: 'send' })).status).toBe(409);
    expect((await b.command(tab, { action: 'equal', checkId: tab.value.checks[0].id, count: 2 })).status).toBe(409);
    expect((await b.request(`/tabs/${tab.id}/checks/${tab.value.checks[0].id}/checkout`, { version: tab.version, registerId: 'bar' })).status).toBe(409);
    expect((await b.request('/state')).data.tickets).toHaveLength(0);
    await b.request('/api/pos/settings', { taxBps: 825 }, { method: 'PUT' });
    viewed = await read();
    expect(viewed.taxPending).toBe(false);
    expect(viewed.value.checks[0].taxCents).toBe(249);
    tab = (await b.command(tab, { action: 'send' }, { key: 'draft-send' })).data;
    expect(tab.value.items).toHaveLength(3);
    expect(tab.value.items.every((i: any) => i.taxPending === false && i.taxCents === 83)).toBe(true);
    expect((await b.request('/state')).data.ingredients[0].value.onHand).toBe(865);
    await b.request('/api/pos/settings', { taxBps: 1000 }, { method: 'PUT' });
    expect((await read()).value.checks[0].taxCents).toBe(249);
  });
  it('persists individual bill names and freezes the name on the receipt when checkout starts', async () => {
    const b = await boot(); let tab = (await b.add(b.tab)).data;
    const checkId = tab.value.checks[0].id;
    tab = (await b.command(tab, { action: 'rename_check', checkId, name: 'Michael — patio' })).data;
    expect((await b.request('/state')).data.tabs[0].value.checks[0].name).toBe('Michael — patio');
    expect((await b.command(tab, { action: 'rename_check', checkId, name: ' ' })).status).toBe(400);
    tab = (await b.command(tab, { action: 'send' })).data;
    const checkout = await b.request(`/tabs/${tab.id}/checks/${checkId}/checkout`, { version: tab.version, registerId: 'bar' });
    const receipt = (await b.request(`/api/pos/receipts/${checkout.data.orderId}`)).data;
    expect(receipt.order.note).toBe('Bill: Michael — patio\nTab: Patio 7\nTable: 7');
    const latest = (await b.request('/state')).data.tabs[0];
    expect((await b.command(latest, { action: 'rename_check', checkId, name: 'Changed after payment' })).status).toBe(409);
  });
  it('keeps an unknown menu price unset and blocks sales until a manager prices it', async () => {
    const b = await boot();
    const preview = await b.request('/menu-import-preview', { csv: 'name,category,price,station\nGrey Goose,Vodka,,bar' });
    expect(preview.data.items[0].priceCents).toBeNull();
    const menu = (await b.request('/menu', { name: 'Grey Goose', category: 'Vodka', priceCents: null,
      happyHour: true, happyHourPriceCents: 500 })).data;
    const add = { action: 'add', menuId: menu.id, checkId: b.tab.value.checks[0].id };
    expect((await b.command(b.tab, add)).status).toBe(409);
    expect((await b.request('/state')).data.tabs[0].value.items).toHaveLength(0);
    expect((await b.request('/menu', { ...menu.value, expectedVersion: menu.version, priceCents: 900, happyHour: false })).status).toBe(200);
    expect((await b.command(b.tab, add)).data.value.items[0].priceCents).toBe(900);
  });
  it('sends the saved preparation instructions with the ordered drink after its menu recipe changes', async () => {
    const b = await boot();
    const instructions = 'Stir 2 oz bourbon with syrup and bitters. Strain over fresh ice.';
    const menu = (await b.request('/menu', { name: 'Old Fashioned', category: 'Cocktails', priceCents: 1400, instructions })).data;
    let tab = (await b.command(b.tab, { action: 'add', menuId: menu.id, checkId: b.tab.value.checks[0].id })).data;
    expect((await b.request('/menu', { ...menu.value, expectedVersion: menu.version, instructions: 'Revised house recipe.' })).status).toBe(200);
    tab = (await b.command(tab, { action: 'send' })).data;
    expect(tab.value.items[0].instructions).toBe(instructions);
    expect((await b.request('/state')).data.tickets[0].value.items[0].instructions).toBe(instructions);
  });
  it('reconciles a signed partial card payment, cash remainder and original-card adjustment', async () => {
    const secret = 'whsec_bar_acceptance';
    const provider = stripeTerminalCheckoutProvider({ secretKey: 'sk_test_simulated_bar', webhookSecret: secret,
      transport: async (url, init) => {
        const body = new URLSearchParams(init.body);
        if (url.endsWith('/payment_intents')) return { status: 200, json: async () => ({ id: 'pi_bar', amount: 500, status: 'requires_payment_method' }) };
        if (url.endsWith('/process_payment_intent')) return { status: 200, json: async () => ({ id: 'tmr_bar', status: 'online', action: { status: 'in_progress' } }) };
        if (url.endsWith('/refunds')) return { status: 200, json: async () => ({ id: 're_bar', payment_intent: 'pi_bar', charge: 'ch_bar', amount: Number(body.get('amount')), status: 'succeeded' }) };
        throw new Error('Unexpected simulated endpoint');
      } });
    const b = await boot({ checkoutProviders: [provider], posCardPresent: { provider: 'stripe_terminal', readerId: 'tmr_bar', verify: async () => ({ verified: true, readerId: 'tmr_bar', status: 'online', checkedAt: new Date().toISOString() }) } });
    const drawer = (await b.request('/api/pos/drawer/open', { drawerRef: 'bar', registerRef: 'bar', openingFloatCents: 0 })).data;
    let tab = (await b.add(b.tab)).data; tab = (await b.command(tab, { action: 'send' })).data;
    const orderId = (await b.request(`/tabs/${tab.id}/checks/${tab.value.checks[0].id}/checkout`, { version: tab.version, registerId: 'bar', cashSessionId: drawer.session.id })).data.orderId;
    expect((await b.request(`/api/pos/orders/${orderId}/card-payments`, { amountCents: 500, idempotencyKey: 'bar-card' })).status).toBe(201);
    const raw = JSON.stringify({ id: 'evt_bar', type: 'payment_intent.succeeded', data: { object: { id: 'pi_bar', status: 'succeeded', amount: 500, amount_received: 500, latest_charge: 'ch_bar' } } });
    const webhook = await b.platform.app.request('/api/orders/webhooks/stripe_terminal', { method: 'POST', headers: { 'x-tenant-id': b.tenant.id, 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader(secret, Math.floor(Date.now()/1000), raw) }, body: raw });
    expect(webhook.status).toBe(200);
    expect((await b.request(`/api/pos/orders/${orderId}/pay`, { tenders: [{ kind: 'cash', amountCents: 584, cashReceivedCents: 1000, idempotencyKey: 'bar-cash' }] })).status).toBe(200);
    const receipt = (await b.request(`/api/pos/receipts/${orderId}`)).data;
    const refund = { tenderId: receipt.tenders.find((t: any) => t.kind === 'provider').id, amountCents: 100, lines: [], reason: 'Prepared item adjustment', idempotencyKey: 'bar-card-refund' };
    expect((await b.request(`/api/pos/orders/${orderId}/refunds`, refund)).status).toBe(201);
    expect((await b.request(`/api/pos/orders/${orderId}/refunds`, refund)).status).toBe(200);
    const after = (await b.request(`/api/pos/receipts/${orderId}`)).data;
    expect(after.amountPaidCents).toBe(1084); expect(after.amountRefundedCents).toBe(100);
    expect((await b.request('/state')).data.ingredients[0].value.onHand).toBe(955);
  });
  it('routes one order to bar and kitchen with preparation notes and void updates', async () => {
    const b = await boot();
    const food = (await b.request('/menu', { name: 'Burger', category: 'Food', prepStation: 'kitchen', priceCents: 1600,
      modifiers: [{ id: 'side', name: 'Side', required: true, choices: [{ id: 'salad', name: 'Salad', priceCents: 200 }] }] })).data;
    let tab = (await b.add(b.tab)).data;
    tab = (await b.command(tab, { action: 'add', checkId: tab.value.checks[0].id, menuId: food.id, seat: 3, selections: { side: 'salad' }, note: 'No onions' })).data;
    tab = (await b.command(tab, { action: 'send' })).data;
    const tickets = (await b.request('/state')).data.tickets;
    expect(tickets).toHaveLength(2);
    const kitchen = tickets.find((t: any) => t.value.station === 'kitchen');
    expect(kitchen.value.items).toHaveLength(1);
    expect(kitchen.value.items[0]).toMatchObject({ name: 'Burger', seat: 3, modifiers: ['Side: Salad', 'Note: No onions'] });
    expect(tickets.find((t: any) => t.value.station === 'bar').value.items[0].name).toBe('Margarita');
    await b.command(tab, { action: 'void', itemId: kitchen.value.items[0].id, reason: 'Guest changed order' });
    expect((await b.request('/state')).data.tickets.find((t: any) => t.id === kitchen.id).value.items[0].voided).toBe(true);
  });
  it('protects concurrent menu/count edits and atomically imports a reviewed menu', async () => {
    const b = await boot();
    const menu = { ...b.menu.value, expectedVersion: b.menu.version, priceCents: 1200 };
    expect((await b.request('/menu', menu)).status).toBe(200);
    expect((await b.request('/menu', menu)).status).toBe(409);
    const tab = (await b.add(b.tab)).data;
    await b.command(tab, { action: 'send' });
    expect((await b.request('/stock', { ...b.stock.value, expectedVersion: b.stock.version, reason: 'Stale count' })).status).toBe(409);
    const preview = await b.request('/menu-import-preview', { csv: 'name,category,price\n"Wine, red",Wine,10.50\nLager,Beer,6.00' });
    expect(preview.data.items[0].priceCents).toBe(1050);
    expect((await b.request('/menu-import', { items: preview.data.items })).data.added).toBe(2);
    const duplicate = await b.request('/menu-import', { items: [{ name: 'New drink', category: 'Beer', priceCents: 100 }, ...preview.data.items] });
    expect(duplicate.status).toBe(409);
    expect((await b.request('/state')).data.menu).toHaveLength(3);
  });
  it('retains long-open tabs and queued rounds after hundreds of closed records', async () => {
    const b = await boot();
    const at = new Date().toISOString();
    await b.db.insertInto('api_bar_documents').values(Array.from({ length: 501 }, (_, n) => ({
      id: `closed-${n}`, tenant_id: b.tenant.id, kind: 'tab', lifecycle: 'closed', version: 1,
      created_at: at, updated_at: at, data: JSON.stringify({ id: `closed-${n}`, name: 'Old', table: '', status: 'closed', items: [], checks: [], openedBy: 'system', closedAt: at }),
    }))).execute();
    const state = (await b.request('/state')).data;
    expect(state.tabs).toHaveLength(101);
    expect(state.tabs.some((t: any) => t.id === b.tab.id)).toBe(true);
    expect(state.summary.openTabs).toBe(1);
  });
  it('stores equipment as pending facts and allows opening a drawer after checkout', async () => {
    const b = await boot();
    const setup = { expectedVersion: 0, venueName: 'ONE Club', devices: [{ id: 'ipad', name: 'Bar iPad', kind: 'ipad' }] };
    const saved = await b.request('/setup', setup);
    expect(saved.data.value.devices[0].access).toBe('pending');
    expect((await b.request('/setup', setup)).status).toBe(409);
    let tab = (await b.add(b.tab)).data; tab = (await b.command(tab, { action: 'send' })).data;
    const checkId = tab.value.checks[0].id;
    const checkout = await b.request(`/tabs/${tab.id}/checks/${checkId}/checkout`, { version: tab.version, registerId: 'bar' });
    const drawer = (await b.request('/api/pos/drawer/open', { drawerRef: 'bar', registerRef: 'bar', openingFloatCents: 0 })).data;
    const attach = `/tabs/${tab.id}/checks/${checkId}/drawer`;
    expect((await b.request(attach, { cashSessionId: drawer.session.id, registerId: 'other' })).status).toBe(409);
    expect((await b.request(attach, { cashSessionId: drawer.session.id, registerId: 'bar' })).status).toBe(200);
    const paid = await b.request(`/api/pos/orders/${checkout.data.orderId}/pay`, { tenders: [{ kind: 'cash', amountCents: 1084, cashReceivedCents: 2000, idempotencyKey: 'late-drawer-cash' }] });
    expect(paid.status).toBe(200);
    const shift = (await b.request('/api/pos/drawer?drawerRef=bar')).data;
    expect(shift.reconciliation.effectiveExpectedCents).toBe(1084);
  });
  it('starts empty, prices modifiers on the server and rejects unknown choices', async () => {
    const b = await boot();
    const invalid = await b.command(b.tab, { action: 'add', checkId: b.tab.value.checks[0].id, menuId: b.menu.id });
    expect(invalid.status).toBe(400);
    const added = await b.command(b.tab, { action: 'add', checkId: b.tab.value.checks[0].id, menuId: b.menu.id,
      selections: { style: 'double' }, priceCents: 1, taxCents: 0 });
    expect(added.status).toBe(200);
    expect(added.data.value.items[0]).toMatchObject({ priceCents: 1402, taxCents: 116, modifiers: ['Style: Double'] });
    const state = (await b.request('/state')).data;
    expect(state.summary).toMatchObject({ openTabs: 1, openBalanceCents: 1518, queuedTickets: 0 });
  });
  it('replays lost responses, rejects key reuse, and prevents concurrent overwrites', async () => {
    const b = await boot();
    const body = { action: 'add', menuId: b.menu.id, checkId: b.tab.value.checks[0].id, selections: { style: 'classic' } };
    const first = await b.command(b.tab, body, { key: 'one-action' });
    const replay = await b.command(b.tab, body, { key: 'one-action' });
    expect(replay.data).toEqual(first.data);
    expect((await b.command(b.tab, { ...body, quantity: 2 }, { key: 'one-action' })).status).toBe(409);
    const concurrent = await Promise.all([b.add(first.data), b.add(first.data)]);
    expect(concurrent.map(v => v.status).sort()).toEqual([200, 409]);
    expect((await b.request('/state')).data.tabs[0].value.items).toHaveLength(2);
  });
  it('deducts stock once when sent and reprices a repeated round from the menu', async () => {
    const b = await boot(); let tab = (await b.add(b.tab, 2)).data;
    const beforeSend = (await b.request('/state')).data.ingredients[0].value.onHand;
    expect(beforeSend).toBe(1000);
    const sent = await b.command(tab, { action: 'send' }, { key: 'send-1' });
    await b.command(tab, { action: 'send' }, { key: 'send-1' }); tab = sent.data;
    const state = (await b.request('/state')).data;
    expect(state.ingredients[0].value.onHand).toBe(910); expect(state.tickets).toHaveLength(1);
    tab = (await b.command(tab, { action: 'repeat', roundId: state.tickets[0].id, checkId: tab.value.checks[0].id })).data;
    expect(tab.value.items).toHaveLength(4);
    expect((await b.request('/state')).data.ingredients[0].value.onHand).toBe(910);
    tab = (await b.command(tab, { action: 'send' })).data;
    expect((await b.request('/state')).data.ingredients[0].value.onHand).toBe(820);
    const ready = await b.request(`/tickets/${state.tickets[0].id}/ready`, {});
    expect(ready.data.value.status).toBe('ready');
    const comp = await b.command(tab, { action: 'comp', itemId: tab.value.items[0].id, reason: 'Guest recovery' });
    expect(comp.status).toBe(200);
    expect((await b.request('/state')).data.ingredients[0].value.onHand).toBe(820);
  });
  it('rolls back the entire round on insufficient ingredients', async () => {
    const b = await boot(); const tab = (await b.add(b.tab, 30)).data;
    expect((await b.command(tab, { action: 'send' })).status).toBe(409);
    const state = (await b.request('/state')).data;
    expect(state.ingredients[0].value.onHand).toBe(1000); expect(state.tickets).toHaveLength(0);
    expect(state.tabs[0].value.items.every((i: any) => i.sentAt === null)).toBe(true);
  });
  it('equal splits keep original tax and produce totals within one cent', async () => {
    const b = await boot(); let tab = (await b.add(b.tab, 7)).data;
    tab = (await b.command(tab, { action: 'tip', checkId: tab.value.checks[0].id, tipCents: 103 })).data;
    tab = (await b.command(tab, { action: 'equal', checkId: tab.value.checks[0].id, count: 3 })).data;
    const checks = (await b.request('/state')).data.tabs[0].value.checks;
    expect(checks.reduce((s: number, c: any) => s + c.totalCents, 0)).toBe(7 * 1084 + 103);
    expect(checks.reduce((s: number, c: any) => s + c.taxCents, 0)).toBe(7 * 83);
    expect(Math.max(...checks.map((c: any) => c.totalCents)) - Math.min(...checks.map((c: any) => c.totalCents))).toBeLessThanOrEqual(1);
    tab = (await b.command(tab, { action: 'send' })).data;
    for (const check of tab.value.checks) {
      const checkout = await b.request(`/tabs/${tab.id}/checks/${check.id}/checkout`, { version: tab.version, registerId: 'bar' });
      expect(checkout.status).toBe(200);
      const receipt = (await b.request(`/api/pos/receipts/${checkout.data.orderId}`)).data;
      expect(receipt.order.tax_cents).toBe(check.allocations.reduce((s: number, a: any) => s + a.taxCents, 0));
      tab = (await b.request('/state')).data.tabs[0];
    }
  });
  it('moves items/seats, merges tabs, and reconciles item splits', async () => {
    const b = await boot(); let tab = (await b.add(b.tab, 2)).data;
    tab = (await b.command(tab, { action: 'split', checkId: tab.value.checks[0].id, itemIds: [tab.value.items[0].id], name: 'Guest 2' })).data;
    expect(tab.value.checks.map((c: any) => c.allocations.length)).toEqual([1, 1]);
    tab = (await b.command(tab, { action: 'move', checkId: tab.value.checks[1].id, itemIds: [tab.value.items[1].id], seat: 3 })).data;
    expect(tab.value.items[1].seat).toBe(3); expect(tab.value.checks[1].allocations).toHaveLength(2);
    const target = (await b.request('/tabs', { name: 'Bar 3' })).data;
    const merged = await b.request(`/tabs/${tab.id}/merge`, { version: tab.version, targetId: target.id, targetVersion: target.version });
    expect(merged.status).toBe(200); expect(merged.data.value.items).toHaveLength(2);
  });
  it('binds checkout once, prevents repricing bypass and closes only after payment', async () => {
    const b = await boot(); let tab = (await b.add(b.tab)).data;
    expect((await b.command(tab, { action: 'close' })).status).toBe(409);
    const drawer = (await b.request('/api/pos/drawer/open', { drawerRef: 'bar', registerRef: 'bar', openingFloatCents: 2000 })).data;
    tab = (await b.command(tab, { action: 'send' })).data;
    const path = `/tabs/${tab.id}/checks/${tab.value.checks[0].id}/checkout`;
    const body = { version: tab.version, registerId: 'bar', cashSessionId: drawer.session.id };
    const created = await b.request(path, body);
    expect(created.status).toBe(200); expect((await b.request(path, body)).data.orderId).toBe(created.data.orderId);
    const orderId = created.data.orderId;
    expect((await b.request(`/api/orders/orders/${orderId}`, { taxBps: 0 }, { method: 'PATCH' })).status).toBe(403);
    expect((await b.request(`/api/orders/orders/${orderId}`, { taxBps: 0 }, { method: 'PUT' })).status).toBe(409);
    tab = (await b.request('/state')).data.tabs[0];
    expect((await b.add(tab)).status).toBe(409);
    expect((await b.command(tab, { action: 'close' })).status).toBe(409);
    const paid = await b.request(`/api/pos/orders/${orderId}/pay`, { tenders: [{ kind: 'cash', amountCents: 1084,
      cashReceivedCents: 2000, idempotencyKey: 'cash-one' }] });
    expect(paid.status).toBe(200);
    const receipt = (await b.request(`/api/pos/receipts/${orderId}`)).data;
    expect(receipt.amountPaidCents).toBe(1084); expect(receipt.order.status).toBe('paid');
    const refund = { tenderId: receipt.tenders[0].id, idempotencyKey: 'prepared-refund', amountCents: 100,
      reason: 'Prepared drink adjustment', lines: [], cashSessionId: drawer.session.id };
    expect((await b.request(`/api/pos/orders/${orderId}/refunds`, refund)).status).toBe(201);
    expect((await b.request(`/api/pos/orders/${orderId}/refunds`, refund)).status).toBe(200);
    expect((await b.request(`/api/pos/receipts/${orderId}`)).data.amountRefundedCents).toBe(100);
    expect((await b.request('/state')).data.ingredients[0].value.onHand).toBe(955);
    expect((await b.command(tab, { action: 'close' })).data.value.status).toBe('closed');
  });
  it('denies tenant access to every document and sensitive staff mutations', async () => {
    const b = await boot();
    const other = await createTenant(asCoreDb(b.db), { name: 'Other' }); await b.platform.seedTenant(other.id);
    const opts = { tenant: other.id };
    const state = await b.request('/state', undefined, opts);
    expect(state.data.menu).toEqual([]); expect(state.data.tabs).toEqual([]); expect(state.data.ingredients).toEqual([]);
    expect((await b.add(b.tab)).status).toBe(200);
    expect((await b.command(b.tab, { action: 'send' }, opts)).status).toBe(404);
    expect((await b.request('/menu', b.menu.value, opts)).status).toBe(404);
    expect((await b.request('/stock', { ...b.stock.value, reason: 'Count' }, opts)).status).toBe(404);
    expect((await b.request('/tickets/unknown/ready', {}, opts)).status).toBe(404);
    const staff = await createUser(asCoreDb(b.db), b.tenant.id, { name: 'Staff', email: 'staff@example.test', role: 'member' });
    const denied = await b.request('/stock', { name: 'New', unit: 'unit', onHand: 1, reason: 'Count' }, { user: staff.id });
    expect([401, 403]).toContain(denied.status);
  });
});
