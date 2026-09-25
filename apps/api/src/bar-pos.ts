/** Standalone bar operations. Server-owned tabs, exact check allocations and stock.
 * Payments use the existing audited POS/order/finance path. No browser prices,
 * local-only tabs, fabricated payments or silently restored poured drinks.
 */
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import { ApiError, asCoreDb, audit, computeTotals, errorHandler, id, nowIso, parseCsvRows,
  tenantMiddleware, type CoreDatabase, type EventBus, type TenantEnv } from '@blacklabel/core';
import { createOrder, getOrder, listTenders, type OrdersDatabase } from '@blacklabel/orders';
import { getCashSession, type FinanceDatabase } from '@blacklabel/finance';
import { can, type WorkforceDatabase } from '@blacklabel/workforce';
import { CONFIG_KEYS, getConfig } from './config';
import type { ApiDatabase } from './migrations';
import type { PosReconciliationTables } from './pos-reconciliation-migrations';
import { withPosCashSessionLock } from './pos-serialization';
import type { BarTables, BarDocumentRow } from './bar-pos-migrations';
import type { GetActingUser } from './rbac';

export type BarDatabase = CoreDatabase & ApiDatabase & BarTables & OrdersDatabase &
  FinanceDatabase & WorkforceDatabase & PosReconciliationTables;
const asDb = <T>(db: Kysely<BarDatabase>) => db as unknown as Kysely<T>;
const money = z.number().int().min(0).max(100_000_000);
const key = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(120);
const recipeSchema = z.array(z.object({ ingredientId: key, quantity: z.number().int().min(1).max(1_000_000) })).max(30);
const choiceSchema = z.object({ id: key, name: text, priceCents: money, recipe: recipeSchema.default([]) });
const groupSchema = z.object({ id: key, name: text, required: z.boolean().default(false),
  choices: z.array(choiceSchema).min(1).max(30) });
const setupSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  venueName: text, supportPhone: z.string().trim().max(80).default(''),
  processorName: z.string().trim().max(120).default(''),
  devices: z.array(z.object({ id: key, name: text, kind: z.enum(['ipad', 'reader', 'printer', 'drawer']),
    model: z.string().trim().max(120).default(''), connection: z.enum(['unknown', 'usb', 'bluetooth', 'network']).default('unknown'),
    access: z.enum(['pending', 'available']).default('pending') }).strict()).max(50),
}).strict();
export const barMenuSchema = z.object({ id: key.optional(), name: text, category: text,
  prepStation: z.enum(['bar', 'kitchen']).default('bar'),
  priceCents: money.nullable(), description: z.string().trim().max(500).default(''),
  instructions: z.string().trim().max(4000).default(''),
  available: z.boolean().default(true), modifiers: z.array(groupSchema).max(12).default([]),
  recipe: recipeSchema.default([]), happyHourPriceCents: money.nullable().default(null),
  happyHour: z.boolean().default(false) }).strict();
type Menu = z.infer<typeof barMenuSchema> & { id: string };
interface Ingredient { id: string; name: string; unit: 'ml' | 'unit'; onHand: number }
interface Item {
  id: string; menuId: string; name: string; category: string; selections: Record<string, string>;
  modifiers: string[]; priceCents: number; taxCents: number; taxPending?: boolean; seat: number; recipe: Menu['recipe'];
  prepStation: 'bar' | 'kitchen'; note: string; instructions: string;
  sentAt: string | null; roundId: string | null; voided: boolean; comped: boolean; reason: string | null;
}
interface Allocation { itemId: string; netCents: number; taxCents: number; share: number }
interface Check { id: string; name: string; allocations: Allocation[]; tipCents: number; orderId: string | null }
export interface BarTab {
  id: string; name: string; table: string; status: 'open' | 'closed' | 'canceled' | 'merged';
  items: Item[]; checks: Check[]; openedBy: string; closedAt: string | null;
}
interface Ticket { id: string; tabId: string; tabName: string; status: 'queued' | 'ready';
  station: 'bar' | 'kitchen'; table: string;
  items: Array<{ id: string; name: string; modifiers: string[]; seat: number; instructions?: string; voided?: boolean }>; sentBy: string }
interface Document<T> { id: string; version: number; createdAt: string; updatedAt: string; value: T }
const addSelectionSchema = z.object({ menuId: key, selections: z.record(z.string()).default({}),
  note: z.string().trim().max(240).default(''), quantity: z.number().int().min(1).max(30).default(1),
  seat: z.number().int().min(1).max(50).default(1) });
const commandSchema = z.discriminatedUnion('action', [
  addSelectionSchema.extend({ action: z.literal('add'), checkId: key, extras: z.array(addSelectionSchema).max(8).default([]) }),
  z.object({ action: z.literal('rename_check'), checkId: key, name: text }),
  z.object({ action: z.literal('repeat'), roundId: key, checkId: key }),
  z.object({ action: z.literal('send') }),
  z.object({ action: z.literal('rename'), name: text, table: z.string().trim().max(80) }),
  z.object({ action: z.literal('split'), checkId: key, itemIds: z.array(key).min(1).max(500), name: text }),
  z.object({ action: z.literal('equal'), checkId: key, count: z.number().int().min(2).max(20) }),
  z.object({ action: z.literal('move'), itemIds: z.array(key).min(1).max(500), checkId: key, seat: z.number().int().min(1).max(50) }),
  z.object({ action: z.literal('comp'), itemId: key, reason: text }),
  z.object({ action: z.literal('void'), itemId: key, reason: text }),
  z.object({ action: z.literal('tip'), checkId: key, tipCents: money }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('cancel'), reason: text }),
]);

function decode<T>(r: BarDocumentRow): Document<T> {
  return { id: r.id, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, value: JSON.parse(r.data) as T };
}
async function read<T>(db: Kysely<BarDatabase>, tenant: string, kind: string, docId: string): Promise<Document<T>> {
  const r = await db.selectFrom('api_bar_documents').selectAll().where('tenant_id', '=', tenant)
    .where('kind', '=', kind).where('id', '=', docId).executeTakeFirst();
  if (!r) throw ApiError.notFound(`${kind} not found`);
  return decode<T>(r);
}
async function list<T>(db: Kysely<BarDatabase>, tenant: string, kind: string, activeState?: string): Promise<Document<T>[]> {
  const base = db.selectFrom('api_bar_documents').selectAll().where('tenant_id', '=', tenant)
    .where('kind', '=', kind).orderBy('updated_at', 'desc').orderBy('id');
  // Active service is never truncated by a busy night of closed checks.
  const r = activeState ? [
    ...await base.where('lifecycle', '=', activeState).execute(),
    ...await base.where('lifecycle', '!=', activeState).limit(100).execute(),
  ] : await base.execute();
  return r.map(decode<T>);
}
async function insert<T extends { id: string }>(db: Kysely<BarDatabase>, tenant: string, kind: string, value: T) {
  const now = nowIso();
  await db.insertInto('api_bar_documents').values({ id: value.id, tenant_id: tenant, kind,
    version: 1, lifecycle: (value as { status?: string }).status ?? '', data: JSON.stringify(value), created_at: now, updated_at: now }).execute();
  return read<T>(db, tenant, kind, value.id);
}
async function update<T>(db: Kysely<BarDatabase>, tenant: string, kind: string, doc: Document<T>, value: T) {
  const r = await db.updateTable('api_bar_documents').set({ data: JSON.stringify(value), lifecycle: (value as { status?: string }).status ?? '',
    version: doc.version + 1, updated_at: nowIso() }).where('tenant_id', '=', tenant)
    .where('id', '=', doc.id).where('kind', '=', kind).where('version', '=', doc.version).executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw ApiError.conflict('This tab changed. Refresh before editing.');
  return read<T>(db, tenant, kind, doc.id);
}
function requireVersion(doc: Document<unknown>, version: number) {
  if (doc.version !== version) throw ApiError.conflict('This record changed. Refresh and review it before saving.');
}
function checkFor(tab: BarTab, checkId: string, editable = true) {
  const check = tab.checks.find(v => v.id === checkId);
  if (!check) throw ApiError.notFound('check not found');
  if (editable && check.orderId) throw ApiError.conflict('This check is locked for payment. Use a new check for additional drinks.');
  return check;
}
function active(tab: BarTab) {
  if (tab.status !== 'open') throw ApiError.conflict('The tab is closed.');
}
function newCheck(name = 'Check 1'): Check { return { id: id(), name, allocations: [], tipCents: 0, orderId: null }; }
function totals(check: Check) {
  const subtotalCents = check.allocations.reduce((s, a) => s + a.netCents, 0);
  const taxCents = check.allocations.reduce((s, a) => s + a.taxCents, 0);
  return { subtotalCents, taxCents, tipCents: check.tipCents, totalCents: subtotalCents + taxCents + check.tipCents };
}
function invariant(tab: BarTab) {
  if (tab.items.length > 500 || tab.checks.length > 50) throw ApiError.badRequest('Tab limit reached; close checks before adding more.');
  const seen = new Set(tab.items.map(i => i.id));
  for (const a of tab.checks.flatMap(c => c.allocations)) {
    if (!seen.has(a.itemId) || !Number.isSafeInteger(a.netCents) || !Number.isSafeInteger(a.taxCents) || a.netCents < 0 || a.taxCents < 0) {
      throw ApiError.conflict('Invalid check allocation.');
    }
  }
  for (const item of tab.items) {
    const allocated = tab.checks.flatMap(c => c.allocations).filter(a => a.itemId === item.id);
    const base = item.voided || item.comped ? 0 : item.priceCents;
    const tax = item.voided || item.comped ? 0 : item.taxCents;
    if (allocated.reduce((s, a) => s + a.netCents, 0) !== base || allocated.reduce((s, a) => s + a.taxCents, 0) !== tax ||
      Math.abs(allocated.reduce((s, a) => s + a.share, 0) - 1) > 0.000001) {
      throw ApiError.conflict('Check allocations do not reconcile to the tab.');
    }
  }
}
async function itemFromMenu(db: Kysely<BarDatabase>, tenant: string, menuId: string,
  selections: Record<string, string>, seat: number, note = ''): Promise<Item> {
  const { value: menu } = await read<Menu>(db, tenant, 'menu', menuId);
  if (!menu.available) throw ApiError.conflict(`${menu.name} is unavailable.`);
  if (menu.priceCents === null) throw ApiError.conflict(`Set the price for ${menu.name} before adding it to a check.`);
  let price = menu.happyHour && menu.happyHourPriceCents !== null ? menu.happyHourPriceCents : menu.priceCents;
  const modifiers: string[] = []; const recipe = [...menu.recipe];
  for (const groupId of Object.keys(selections)) {
    if (!menu.modifiers.some(g => g.id === groupId)) throw ApiError.badRequest('Unknown modifier group.');
  }
  for (const group of menu.modifiers) {
    const selection = selections[group.id];
    if (!selection) { if (group.required) throw ApiError.badRequest(`Choose ${group.name}.`); continue; }
    const choice = group.choices.find(v => v.id === selection);
    if (!choice) throw ApiError.badRequest(`Invalid ${group.name} selection.`);
    price += choice.priceCents; modifiers.push(`${group.name}: ${choice.name}`); recipe.push(...choice.recipe);
  }
  const taxBps = await venueTaxRate(db, tenant);
  const computed = computeTotals([{ quantity: 1, unitPriceCents: price }], { taxBps: taxBps ?? 0 });
  if (note) modifiers.push(`Note: ${note}`);
  return { id: id(), menuId, name: menu.name, category: menu.category, selections, modifiers,
    prepStation: menu.prepStation ?? 'bar', note, instructions: menu.instructions || '',
    priceCents: computed.subtotalCents, taxCents: computed.taxCents, taxPending: taxBps === null, seat, recipe,
    sentAt: null, roundId: null, voided: false, comped: false, reason: null };
}
function addItem(tab: BarTab, item: Item, check: Check) {
  tab.items.push(item); check.allocations.push({ itemId: item.id, netCents: item.priceCents, taxCents: item.taxCents, share: 1 });
}
async function venueTaxRate(db: Kysely<BarDatabase>, tenant: string): Promise<number | null> {
  const raw = await getConfig(asDb<ApiDatabase>(db), tenant, CONFIG_KEYS.posTaxBps);
  if (raw === undefined || raw === null || raw === '') return null;
  const rate = Number(raw);
  if (!Number.isInteger(rate) || rate < 0 || rate > 10000) throw ApiError.conflict('The venue tax rate is invalid.');
  return rate;
}
async function resolveDraftTax(db: Kysely<BarDatabase>, tenant: string, tab: BarTab) {
  if (!tab.items.some(i => i.taxPending)) return;
  const rate = await venueTaxRate(db, tenant);
  if (rate === null) return;
  for (const item of tab.items.filter(i => i.taxPending)) {
    item.taxCents = item.voided || item.comped ? 0 : computeTotals([{ quantity: 1, unitPriceCents: item.priceCents }], { taxBps: rate }).taxCents;
    const allocations = tab.checks.flatMap(c => c.allocations).filter(a => a.itemId === item.id);
    const parts = allocations.map((a, index) => ({ a, index, exact: item.taxCents * a.share }));
    for (const p of parts) p.a.taxCents = Math.floor(p.exact);
    const remainder = item.taxCents - parts.reduce((sum, p) => sum + p.a.taxCents, 0);
    parts.sort((a, b) => (b.exact - b.a.taxCents) - (a.exact - a.a.taxCents) || a.index - b.index);
    for (let n = 0; n < remainder; n++) parts[n % parts.length].a.taxCents++;
    item.taxPending = false;
  }
}
function taxPending(tab: BarTab, check?: Check) {
  return tab.items.some(i => i.taxPending && !i.voided && !i.comped && (!check || check.allocations.some(a => a.itemId === i.id)));
}
async function addSelections(db: Kysely<BarDatabase>, tenant: string, tab: BarTab, check: Check, selections: z.infer<typeof addSelectionSchema>[]) {
  for (const selection of selections) for (let n = 0; n < selection.quantity; n++) {
    addItem(tab, await itemFromMenu(db, tenant, selection.menuId, selection.selections, selection.seat, selection.note), check);
  }
  invariant(tab);
}
async function viewTab(db: Kysely<BarDatabase>, tenant: string, doc: Document<BarTab>) {
  await resolveDraftTax(db, tenant, doc.value);
  const checks = [];
  for (const check of doc.value.checks) {
    const order = check.orderId ? await getOrder(asDb<OrdersDatabase>(db), tenant, check.orderId) : null;
    const tenders = check.orderId ? await listTenders(asDb<OrdersDatabase>(db), tenant, check.orderId) : [];
    const capturedCents = tenders.filter(t => ['captured', 'partially_refunded', 'refunded'].includes(t.status)).reduce((s, t) => s + t.amount_cents, 0);
    checks.push({ ...check, ...totals(check), taxPending: taxPending(doc.value, check), status: order?.order.status ?? 'open', capturedCents,
      remainingCents: Math.max(0, totals(check).totalCents - capturedCents) });
  }
  return { ...doc, value: { ...doc.value, checks }, taxPending: taxPending(doc.value), totalCents: checks.reduce((s, c) => s + c.totalCents, 0),
    remainingCents: checks.reduce((s, c) => s + (c.status === 'canceled' ? 0 : c.remainingCents), 0) };
}

export function barPosRouter(db: Kysely<BarDatabase>, events: EventBus, getActingUser: GetActingUser) {
  const app = new Hono<TenantEnv>(); app.onError(errorHandler); app.use('*', tenantMiddleware(asCoreDb(db)));
  async function identity(c: Context) {
    const tenant = c.get('tenantId') as string; const actor = await getActingUser(c, tenant);
    if (!actor) throw ApiError.unauthorized('Sign in to the register.');
    return { tenant, actor };
  }
  async function manager(trx: Kysely<BarDatabase>, tenant: string, actor: string) {
    if (!await can(asDb<WorkforceDatabase>(trx), tenant, actor, 'admin.admin')) throw ApiError.forbidden('A manager must approve this action.');
  }
  async function mutation<T>(c: Context, action: string, body: unknown,
    work: (trx: Kysely<BarDatabase>, tenant: string, actor: string) => Promise<T>) {
    const { tenant, actor } = await identity(c);
    const requestKey = key.parse(c.req.header('idempotency-key'));
    const hash = createHash('sha256').update(JSON.stringify([action, actor, body])).digest('hex');
    let replayed = false;
    const result = await withPosCashSessionLock(tenant, 'bar-workspace', () => db.transaction().execute(async trx => {
      const prior = await trx.selectFrom('api_bar_commands').selectAll().where('tenant_id', '=', tenant)
        .where('request_key', '=', requestKey).executeTakeFirst();
      if (prior) {
        if (prior.fact_hash !== hash) throw ApiError.conflict('This request key belongs to a different action.');
        replayed = true; return JSON.parse(prior.result) as T;
      }
      const value = await work(trx, tenant, actor);
      await audit(asCoreDb(trx), tenant, actor, `bar.${action}.changed`, 'bar.workspace', tenant, { requestKey, command: body });
      await trx.insertInto('api_bar_commands').values({ id: id(), tenant_id: tenant, request_key: requestKey,
        fact_hash: hash, result: JSON.stringify(value), created_at: nowIso() }).execute();
      return value;
    }));
    if (!replayed) events.emit(tenant, 'bar.workspace.changed', { v: 1, action });
    return c.json({ data: result });
  }

  app.get('/state', async c => {
    const { tenant, actor } = await identity(c);
    const menu = await list<Menu>(db, tenant, 'menu');
    const tabs = await list<BarTab>(db, tenant, 'tab', 'open');
    const tickets = await list<Ticket>(db, tenant, 'ticket', 'queued');
    const ingredients = await list<Ingredient>(db, tenant, 'ingredient');
    const tabViews = await Promise.all(tabs.map(t => viewTab(db, tenant, t)));
    return c.json({ data: { menu, tabs: tabViews, tickets, ingredients,
      canManage: await can(asDb<WorkforceDatabase>(db), tenant, actor, 'admin.admin'), asOf: nowIso(),
      summary: { openTabs: tabViews.filter(t => t.value.status === 'open').length,
        openBalanceCents: tabViews.filter(t => t.value.status === 'open').reduce((s, t) => s + t.remainingCents, 0),
        queuedTickets: tickets.filter(t => t.value.status === 'queued').length } } });
  });
  app.get('/setup', async c => {
    const { tenant, actor } = await identity(c); await manager(db, tenant, actor);
    const setup = (await list(db, tenant, 'setup'))[0] ?? null;
    return c.json({ data: setup });
  });
  app.post('/setup', async c => {
    const body = setupSchema.parse(await c.req.json());
    return mutation(c, 'setup', body, async (trx, tenant, actor) => {
      await manager(trx, tenant, actor);
      if (body.devices.filter(d => d.kind === 'ipad').length > 1 || body.devices.filter(d => d.kind === 'drawer').length > 1) throw ApiError.badRequest('This bar uses one iPad and one cash drawer.');
      if (new Set(body.devices.map(d => d.id)).size !== body.devices.length) throw ApiError.badRequest('Device identifiers must be unique.');
      const old = (await list(trx, tenant, 'setup'))[0];
      if ((old?.version ?? 0) !== body.expectedVersion) throw ApiError.conflict('Setup changed. Reopen setup before saving.');
      const { expectedVersion, ...fields } = body;
      const value = { ...fields, id: old?.id ?? id() };
      return old ? update(trx, tenant, 'setup', old, value) : insert(trx, tenant, 'setup', value);
    });
  });
  // Add-only import keeps existing drinks, recipes and historical checks intact.
  app.post('/menu-import-preview', async c => {
    const { tenant, actor } = await identity(c); await manager(db, tenant, actor);
    const { csv } = z.object({ csv: z.string().min(1).max(250_000) }).parse(await c.req.json());
    let rows: string[][];
    try { rows = parseCsvRows(csv.replace(/^\uFEFF/, '')); } catch { throw ApiError.badRequest('Check the CSV quotes and try again.'); }
    const header = rows.shift()?.map(v => v.trim().toLowerCase());
    if (!['name,category,price', 'name,category,price,station'].includes(header?.join(',') ?? '')) throw ApiError.badRequest('Use name,category,price,station. Set station to bar or kitchen.');
    const items = rows.filter(r => r.some(v => v.trim())).map((r, i) => {
      if (r.length !== header!.length || (r[2].trim() && !/^\d+(\.\d{1,2})?$/.test(r[2].trim()))) throw ApiError.badRequest(`Row ${i + 2}: enter a price such as 12.50, or leave it blank until confirmed.`);
      const [whole, fraction = ''] = r[2].trim().split('.');
      return barMenuSchema.omit({ id: true }).parse({ name: r[0], category: r[1], prepStation: r[3]?.trim().toLowerCase() || 'bar', priceCents: r[2].trim() ? Number(whole) * 100 + Number(fraction.padEnd(2, '0')) : null });
    });
    if (!items.length || items.length > 500) throw ApiError.badRequest('Import between 1 and 500 drinks at a time.');
    return c.json({ data: { items } });
  });
  app.post('/menu-import', async c => {
    const body = z.object({ items: z.array(barMenuSchema.omit({ id: true })).min(1).max(500) }).strict().parse(await c.req.json());
    return mutation(c, 'menu_import', body, async (trx, tenant, actor) => {
      await manager(trx, tenant, actor);
      const existing = await list<Menu>(trx, tenant, 'menu');
      const names = new Set(existing.map(d => `${d.value.category.toLowerCase()}\n${d.value.name.toLowerCase()}`));
      const added = [];
      for (const item of body.items) {
        const name = `${item.category.toLowerCase()}\n${item.name.toLowerCase()}`;
        if (names.has(name)) throw ApiError.conflict(`A drink named ${item.name} already exists in ${item.category}. No drinks were imported.`);
        names.add(name);
        if (item.modifiers.length || item.recipe.length) throw ApiError.badRequest('Use the drink editor for recipes and options after importing the basic menu.');
        added.push(await insert(trx, tenant, 'menu', { ...item, id: id() }));
      }
      return { added: added.length };
    });
  });
  app.post('/menu', async c => {
    const body = barMenuSchema.extend({ expectedVersion: z.number().int().positive().optional() }).parse(await c.req.json());
    return mutation(c, 'menu', body, async (trx, tenant, actor) => {
      await manager(trx, tenant, actor);
      if (new Set(body.modifiers.map(g => g.id)).size !== body.modifiers.length ||
        body.modifiers.some(g => new Set(g.choices.map(v => v.id)).size !== g.choices.length)) throw ApiError.badRequest('Modifier identifiers must be unique.');
      for (const r of [...body.recipe, ...body.modifiers.flatMap(g => g.choices.flatMap(v => v.recipe))]) await read(trx, tenant, 'ingredient', r.ingredientId);
      const { expectedVersion, ...menu } = body;
      const value: Menu = { ...menu, id: body.id ?? id() };
      if (body.id) {
        const old = await read<Menu>(trx, tenant, 'menu', body.id);
        requireVersion(old, expectedVersion ?? -1);
        return update(trx, tenant, 'menu', old, value);
      }
      return insert(trx, tenant, 'menu', value);
    });
  });
  app.post('/stock', async c => {
    const body = z.object({ id: key.optional(), expectedVersion: z.number().int().positive().optional(), name: text, unit: z.enum(['ml', 'unit']),
      onHand: z.number().int().min(0).max(1_000_000_000), reason: text }).strict().parse(await c.req.json());
    return mutation(c, 'stock', body, async (trx, tenant, actor) => {
      await manager(trx, tenant, actor);
      const value: Ingredient = { id: body.id ?? id(), name: body.name, unit: body.unit, onHand: body.onHand };
      const old = body.id ? await read<Ingredient>(trx, tenant, 'ingredient', body.id) : null;
      if (old) requireVersion(old, body.expectedVersion ?? -1);
      if (old && old.value.unit !== body.unit) throw ApiError.conflict('Create a new ingredient to change its stock unit.');
      const result = old ? await update(trx, tenant, 'ingredient', old, value) : await insert(trx, tenant, 'ingredient', value);
      await insert(trx, tenant, 'stock_movement', { id: id(), ingredientId: value.id,
        delta: value.onHand - (old?.value.onHand ?? 0), reason: body.reason, actor });
      return result;
    });
  });
  app.post('/tabs', async c => {
    const body = z.object({ name: text, table: z.string().trim().max(80).default(''), billName: text.optional(),
      initialItems: z.array(addSelectionSchema).max(9).default([]) }).strict().parse(await c.req.json());
    return mutation(c, 'tab_created', body, async (trx, tenant, actor) => {
      const tab: BarTab = { id: id(), name: body.name, table: body.table, status: 'open', items: [],
        checks: [newCheck(body.billName)], openedBy: actor, closedAt: null };
      await addSelections(trx, tenant, tab, tab.checks[0], body.initialItems);
      return insert<BarTab>(trx, tenant, 'tab', tab);
    });
  });
  app.post('/tabs/:tabId/commands', async c => {
    const raw = await c.req.json(); const version = z.number().int().positive().parse(raw.version);
    const cmd = commandSchema.parse(raw); const tabId = c.req.param('tabId');
    return mutation(c, `tab_${cmd.action}`, { tabId, version, cmd }, async (trx, tenant, actor) => {
      const doc = await read<BarTab>(trx, tenant, 'tab', tabId); requireVersion(doc, version);
      const tab = doc.value; active(tab);
      await resolveDraftTax(trx, tenant, tab);
      if (['split', 'equal'].includes(cmd.action) && taxPending(tab)) throw ApiError.conflict('Set the venue tax rate before splitting this bill.');
      if (cmd.action === 'add') {
        const check = checkFor(tab, cmd.checkId);
        await addSelections(trx, tenant, tab, check, [cmd, ...cmd.extras]);
      } else if (cmd.action === 'rename_check') {
        checkFor(tab, cmd.checkId).name = cmd.name;
      } else if (cmd.action === 'repeat') {
        const round = tab.items.filter(i => i.roundId === cmd.roundId && !i.voided);
        if (!round.length) throw ApiError.notFound('round not found');
        const check = checkFor(tab, cmd.checkId);
        for (const old of round) addItem(tab, await itemFromMenu(trx, tenant, old.menuId, old.selections, old.seat, old.note), check);
      } else if (cmd.action === 'rename') {
        tab.name = cmd.name; tab.table = cmd.table;
      } else if (cmd.action === 'send') {
        if (taxPending(tab)) throw ApiError.conflict('Items are saved. Set the venue tax rate before sending this round.');
        const items = tab.items.filter(i => !i.sentAt && !i.voided);
        if (!items.length) throw ApiError.conflict('No unsent drinks.');
        const usage = new Map<string, number>();
        for (const item of items) for (const r of item.recipe) usage.set(r.ingredientId, (usage.get(r.ingredientId) ?? 0) + r.quantity);
        const ticketId = id(); const at = nowIso();
        for (const [ingredientId, quantity] of usage) {
          const ingredient = await read<Ingredient>(trx, tenant, 'ingredient', ingredientId);
          if (ingredient.value.onHand < quantity) throw ApiError.conflict(`Not enough ${ingredient.value.name}. Update stock or change the round.`);
          await update(trx, tenant, 'ingredient', ingredient, { ...ingredient.value, onHand: ingredient.value.onHand - quantity });
          await insert(trx, tenant, 'stock_movement', { id: id(), ingredientId, delta: -quantity, reason: 'round_sent', tabId, ticketId, actor });
        }
        for (const station of ['bar', 'kitchen'] as const) {
          const routed = items.filter(i => (i.prepStation ?? 'bar') === station);
          if (!routed.length) continue;
          await insert<Ticket>(trx, tenant, 'ticket', { id: station === 'bar' ? ticketId : `${ticketId}:kitchen`, tabId, tabName: tab.name,
            station, table: tab.table, status: 'queued', items: routed.map(i => ({ id: i.id, name: i.name, modifiers: i.modifiers, seat: i.seat, instructions: i.instructions || '' })), sentBy: actor });
        }
        for (const item of items) { item.sentAt = at; item.roundId = ticketId; }
      } else if (cmd.action === 'split') {
        const original = checkFor(tab, cmd.checkId); const selected = new Set(cmd.itemIds);
        if (selected.size !== cmd.itemIds.length || !cmd.itemIds.every(v => original.allocations.some(a => a.itemId === v))) throw ApiError.badRequest('Select drinks from this check.');
        const next = newCheck(cmd.name); next.allocations = original.allocations.filter(a => selected.has(a.itemId));
        original.allocations = original.allocations.filter(a => !selected.has(a.itemId)); tab.checks.push(next);
      } else if (cmd.action === 'equal') {
        const original = checkFor(tab, cmd.checkId);
        if (!original.allocations.length) throw ApiError.conflict('The check is empty.');
        const next = Array.from({ length: cmd.count }, (_, n) => newCheck(`${original.name} · ${n + 1}/${cmd.count}`));
        // Rotate remainder pennies across checks, including tax and tips. Every
        // resulting total differs by at most one cent, even for many shared items.
        let cursor = 0;
        const divide = (amount: number) => {
          const parts = Array.from({ length: cmd.count }, () => Math.floor(amount / cmd.count));
          for (let i = 0; i < amount % cmd.count; i++) { parts[cursor]++; cursor = (cursor + 1) % cmd.count; }
          return parts;
        };
        for (const a of original.allocations) {
          const net = divide(a.netCents); const tax = divide(a.taxCents);
          for (let n = 0; n < cmd.count; n++) next[n].allocations.push({ itemId: a.itemId,
            netCents: net[n], taxCents: tax[n], share: a.share / cmd.count });
        }
        const tips = divide(original.tipCents);
        next.forEach((c, n) => { c.tipCents = tips[n]; });
        tab.checks.splice(tab.checks.indexOf(original), 1, ...next);
      } else if (cmd.action === 'move') {
        const target = checkFor(tab, cmd.checkId);
        for (const itemId of new Set(cmd.itemIds)) {
          const item = tab.items.find(i => i.id === itemId); if (!item) throw ApiError.notFound('drink not found');
          const allocations: Allocation[] = [];
          for (const check of tab.checks) {
            if (!check.allocations.some(a => a.itemId === itemId)) continue;
            checkFor(tab, check.id); allocations.push(...check.allocations.filter(a => a.itemId === itemId));
            check.allocations = check.allocations.filter(a => a.itemId !== itemId);
          }
          target.allocations.push({ itemId, netCents: allocations.reduce((s, a) => s + a.netCents, 0),
            taxCents: allocations.reduce((s, a) => s + a.taxCents, 0), share: 1 }); item.seat = cmd.seat;
        }
      } else if (cmd.action === 'comp' || cmd.action === 'void') {
        await manager(trx, tenant, actor);
        const item = tab.items.find(i => i.id === cmd.itemId); if (!item) throw ApiError.notFound('drink not found');
        if (item.voided) throw ApiError.conflict('The drink is already voided.');
        for (const check of tab.checks) if (check.allocations.some(a => a.itemId === item.id)) {
          checkFor(tab, check.id); for (const a of check.allocations.filter(a => a.itemId === item.id)) { a.netCents = 0; a.taxCents = 0; }
        }
        item.reason = cmd.reason;
        if (cmd.action === 'void') item.voided = true; else item.comped = true;
      } else if (cmd.action === 'tip') {
        checkFor(tab, cmd.checkId).tipCents = cmd.tipCents;
      } else if (cmd.action === 'cancel') {
        await manager(trx, tenant, actor);
        if (tab.checks.some(check => check.orderId)) throw ApiError.conflict('Resolve the payment checks before canceling this tab.');
        tab.status = 'canceled'; tab.closedAt = nowIso();
        for (const item of tab.items) { item.voided = true; item.reason = cmd.reason; }
        for (const check of tab.checks) { check.tipCents = 0; for (const a of check.allocations) { a.netCents = 0; a.taxCents = 0; } }
      } else if (cmd.action === 'close') {
        if (tab.items.some(i => !i.sentAt && !i.voided)) throw ApiError.conflict('Send or void the remaining drinks before closing.');
        for (const check of tab.checks) {
          if (!check.allocations.length && !check.tipCents) continue;
          const order = check.orderId ? await getOrder(asDb<OrdersDatabase>(trx), tenant, check.orderId) : null;
          if (!order || !['paid', 'partially_fulfilled', 'fulfilled', 'partially_returned', 'returned', 'canceled'].includes(order.order.status)) throw ApiError.conflict('Every check must be paid or canceled before closing.');
        }
        tab.status = 'closed'; tab.closedAt = nowIso();
      }
      if (cmd.action === 'void' || cmd.action === 'cancel') {
        const tickets = await list<Ticket>(trx, tenant, 'ticket', 'queued');
        for (const ticket of tickets.filter(t => t.value.tabId === tabId && t.value.status === 'queued')) {
          for (const item of ticket.value.items) item.voided = tab.items.find(i => i.id === item.id)?.voided ?? false;
          await update(trx, tenant, 'ticket', ticket, ticket.value);
        }
      }
      invariant(tab); return update(trx, tenant, 'tab', doc, tab);
    });
  });
  app.post('/tabs/:tabId/new-check', async c => {
    const body = z.object({ version: z.number().int().positive(), name: text }).strict().parse(await c.req.json());
    const tabId = c.req.param('tabId');
    return mutation(c, 'new_check', { tabId, ...body }, async (trx, tenant) => {
      const doc = await read<BarTab>(trx, tenant, 'tab', tabId); requireVersion(doc, body.version); active(doc.value);
      doc.value.checks.push(newCheck(body.name)); invariant(doc.value); return update(trx, tenant, 'tab', doc, doc.value);
    });
  });
  app.post('/tabs/:tabId/merge', async c => {
    const body = z.object({ version: z.number().int().positive(), targetId: key, targetVersion: z.number().int().positive() }).strict().parse(await c.req.json());
    const tabId = c.req.param('tabId');
    return mutation(c, 'merge', { tabId, ...body }, async (trx, tenant) => {
      if (body.targetId === tabId) throw ApiError.badRequest('Choose a different tab.');
      const source = await read<BarTab>(trx, tenant, 'tab', tabId); const target = await read<BarTab>(trx, tenant, 'tab', body.targetId);
      requireVersion(source, body.version); requireVersion(target, body.targetVersion); active(source.value); active(target.value);
      if ([...source.value.checks, ...target.value.checks].some(c => c.orderId)) throw ApiError.conflict('Merge tabs before starting payment.');
      target.value.items.push(...source.value.items); target.value.checks.push(...source.value.checks);
      invariant(target.value); source.value.status = 'merged'; source.value.closedAt = nowIso();
      await update(trx, tenant, 'tab', source, source.value);
      return update(trx, tenant, 'tab', target, target.value);
    });
  });
  app.post('/tabs/:tabId/checks/:checkId/checkout', async c => {
    const body = z.object({ version: z.number().int().positive(), registerId: key,
      cashSessionId: key.optional() }).strict().parse(await c.req.json());
    const tabId = c.req.param('tabId'); const checkId = c.req.param('checkId');
    return mutation(c, 'checkout', { tabId, checkId, ...body }, async (trx, tenant, actor) => {
      const doc = await read<BarTab>(trx, tenant, 'tab', tabId); const tab = doc.value; active(tab);
      const check = checkFor(tab, checkId, false);
      if (check.orderId) return { orderId: check.orderId, tabId, checkId };
      await resolveDraftTax(trx, tenant, tab);
      if (taxPending(tab, check)) throw ApiError.conflict('Items are saved. Set the venue tax rate before taking payment.');
      requireVersion(doc, body.version); invariant(tab);
      if (!check.allocations.length) throw ApiError.conflict('The check is empty.');
      const items = check.allocations.map(a => ({ allocation: a, item: tab.items.find(i => i.id === a.itemId)! }));
      if (items.some(({ item }) => !item.sentAt && !item.voided)) throw ApiError.conflict('Send the drinks before taking payment.');
      if (body.cashSessionId) {
        const session = await getCashSession(asDb<FinanceDatabase>(trx), tenant, body.cashSessionId);
        if (session.status !== 'open' || session.expected_mode !== 'ledger' ||
          (session.register_ref && session.register_ref !== body.registerId)) throw ApiError.conflict('Use an open drawer for this register.');
      }
      const total = totals(check); const cartId = `bar:${tabId}:${checkId}`;
      const created = await createOrder({ db: asDb<OrdersDatabase>(trx), events }, tenant, actor, {
        channel: 'pos', source: 'mags', sourceOrderId: `pos:${cartId}`, registerId: body.registerId,
        cashierId: actor, cashSessionId: body.cashSessionId, taxBps: 0, allocatedTaxCents: total.taxCents,
        tipCents: total.tipCents, lines: items.map(({ item, allocation: a }) => ({
          description: `${item.name}${item.modifiers.length ? ' · ' + item.modifiers.join(', ') : ''}${a.share < 0.999999 ? ` · shared ${Math.round(a.share * 100)}%` : ''}${item.comped ? ' · COMP' : ''}${item.voided ? ' · VOID' : ''}`,
          qty: 1, unitPriceCents: a.netCents,
        })), note: `Bill: ${check.name}\nTab: ${tab.name}${tab.table ? `\nTable: ${tab.table}` : ''}`,
      });
      check.orderId = created.order.id;
      await trx.insertInto('api_pos_order_claims').values({ id: created.order.id, tenant_id: tenant,
        order_id: created.order.id, cart_id: cartId, created_at: nowIso() }).execute();
      await trx.insertInto('api_pos_cart_facts').values({ id: created.order.id, tenant_id: tenant,
        order_id: created.order.id, cart_id: cartId, fact_hash: createHash('sha256').update(`bar-check:${check.id}`).digest('hex'), created_at: nowIso() }).execute();
      await update(trx, tenant, 'tab', doc, tab);
      return { orderId: check.orderId, tabId, checkId };
    });
  });
  app.post('/tickets/:ticketId/ready', async c => {
    const ticketId = c.req.param('ticketId');
    return mutation(c, 'ticket_ready', { ticketId }, async (trx, tenant) => {
      const doc = await read<Ticket>(trx, tenant, 'ticket', ticketId);
      return doc.value.status === 'ready' ? doc : update(trx, tenant, 'ticket', doc, { ...doc.value, status: 'ready' });
    });
  });
  app.post('/tabs/:tabId/checks/:checkId/drawer', async c => {
    const body = z.object({ cashSessionId: key, registerId: key }).strict().parse(await c.req.json());
    const tabId = c.req.param('tabId'); const checkId = c.req.param('checkId');
    return mutation(c, 'check_drawer', { tabId, checkId, ...body }, async (trx, tenant) => {
      const doc = await read<BarTab>(trx, tenant, 'tab', tabId); active(doc.value);
      const check = checkFor(doc.value, checkId, false);
      if (!check.orderId) throw ApiError.conflict('Start checkout first.');
      const order = await getOrder(asDb<OrdersDatabase>(trx), tenant, check.orderId);
      if (!order || order.order.register_id !== body.registerId) throw ApiError.conflict('Use the register that started this payment.');
      if (order.order.cash_session_id) {
        if (order.order.cash_session_id !== body.cashSessionId) throw ApiError.conflict('The check is already assigned to another drawer shift.');
        return { cashSessionId: body.cashSessionId };
      }
      if (!['draft', 'reserved', 'partially_paid'].includes(order.order.status)) throw ApiError.conflict('This payment is already closed.');
      const cash = await getCashSession(asDb<FinanceDatabase>(trx), tenant, body.cashSessionId);
      if (cash.status !== 'open' || cash.expected_mode !== 'ledger' || cash.register_ref !== body.registerId) throw ApiError.conflict('Use an open drawer belonging to this register.');
      await trx.updateTable('orders_orders').set({ cash_session_id: cash.id, updated_at: nowIso() })
        .where('tenant_id', '=', tenant).where('id', '=', check.orderId).where('cash_session_id', 'is', null).execute();
      return { cashSessionId: cash.id };
    });
  });
  return app;
}
