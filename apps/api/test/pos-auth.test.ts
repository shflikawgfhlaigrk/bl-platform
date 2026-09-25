import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createLocation, type InventoryDatabase } from '@blacklabel/inventory';
import { createApp, type PlatformDatabase } from '../src/app';

const KEY = Buffer.alloc(32, 11);

async function boot() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db, adminMasterKey: KEY });
  const tenant = await createTenant(asCoreDb(db), { name: 'Authenticated POS' });
  const seeded = await platform.seedTenant(tenant.id, { ownerName: 'Morgan Owner' });
  return { db, platform, tenantId: tenant.id, ownerId: seeded.ownerUserId };
}

function browserHeaders(tenantId: string, cookie?: string, claimedUserId?: string) {
  return {
    'x-tenant-id': tenantId,
    'x-mags-csrf': '1',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    ...(cookie ? { cookie } : {}),
    ...(claimedUserId ? { 'x-user-id': claimedUserId } : {}),
  };
}

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie');
  expect(value).toBeTruthy();
  return String(value).split(';')[0];
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function bootstrap(
  platform: Awaited<ReturnType<typeof createApp>>,
  tenantId: string,
  pin = '2468',
) {
  const response = await platform.app.request('/api/pos/auth/bootstrap', {
    method: 'POST',
    headers: browserHeaders(tenantId),
    body: JSON.stringify({ pin }),
  });
  expect(response.status).toBe(201);
  return { cookie: cookieFrom(response), body: await json(response) };
}

describe('POS browser operator sessions', () => {
  it('requires exactly four digits for every PIN entry path', async () => {
    const { platform, tenantId, ownerId } = await boot();
    for (const pin of ['123', '12345', '123456789012', 'abcd']) {
      const response = await platform.app.request('/api/pos/auth/bootstrap', {
        method: 'POST', headers: browserHeaders(tenantId), body: JSON.stringify({ pin }),
      });
      expect(response.status).toBe(400);
    }
    await bootstrap(platform, tenantId, '0123');
    const response = await platform.app.request('/api/pos/auth/session', {
      method: 'POST', headers: browserHeaders(tenantId), body: JSON.stringify({ userId: ownerId, pin: '0123' }),
    });
    expect(response.status).toBe(201);
  });
  it('fails closed for browser GETs and mutations even when x-user-id claims the owner', async () => {
    const { platform, tenantId, ownerId } = await boot();

    const health = await platform.app.request('/api/health', {
      headers: browserHeaders(tenantId, undefined, ownerId),
    });
    expect(health.status).toBe(200);

    const read = await platform.app.request('/api/pos/readiness', {
      headers: browserHeaders(tenantId, undefined, ownerId),
    });
    expect(read.status).toBe(401);

    // This route has no POS-specific rule; the global browser guard still
    // prevents an implicit owner from leaking into the wider API surface.
    const widerRead = await platform.app.request('/api/catalog/products', {
      headers: browserHeaders(tenantId, undefined, ownerId),
    });
    expect(widerRead.status).toBe(401);

    const mutation = await platform.app.request('/api/pos/settings', {
      method: 'PUT',
      headers: browserHeaders(tenantId, undefined, ownerId),
      body: JSON.stringify({ taxBps: 0 }),
    });
    expect(mutation.status).toBe(401);

    const directory = await platform.app.request('/api/pos/auth/operators', {
      headers: browserHeaders(tenantId),
    });
    expect(directory.status).toBe(200);
    expect((await json(directory)).data).toMatchObject({
      bootstrapRequired: true,
      operators: [expect.objectContaining({ id: ownerId, name: 'Morgan Owner', pinConfigured: false })],
    });
  });

  it('stores only PIN/token verifiers and honors workforce session invalidation', async () => {
    const { db, platform, tenantId, ownerId } = await boot();
    const { cookie, body } = await bootstrap(platform, tenantId);
    expect(body.data).toMatchObject({ id: ownerId, name: 'Morgan Owner', canManageOperators: true });

    const rawToken = cookie.slice(cookie.indexOf('=') + 1);
    const credential = await db
      .selectFrom('api_pos_credentials')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    expect(credential.pin_hash).not.toContain('2468');
    expect(credential.pin_salt).not.toContain('2468');

    const session = await db
      .selectFrom('api_pos_sessions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    expect(session.token_hash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(session.token_hash).not.toBe(rawToken);

    const current = await platform.app.request('/api/pos/auth/session', {
      headers: browserHeaders(tenantId, cookie),
    });
    expect(current.status).toBe(200);

    const invalidate = await platform.app.request('/api/workforce/session-policy/invalidate-all', {
      method: 'POST',
      headers: browserHeaders(tenantId, cookie),
      body: '{}',
    });
    expect(invalidate.status).toBe(200);

    const expired = await platform.app.request('/api/pos/readiness', {
      headers: browserHeaders(tenantId, cookie),
    });
    expect(expired.status).toBe(401);
  });

  it('uses the signed-in cashier for RBAC, drawer ownership, and order attribution', async () => {
    const { db, platform, tenantId, ownerId } = await boot();
    const owner = await bootstrap(platform, tenantId);
    const ownerCookie = owner.cookie;

    const location = await createLocation(
      db as unknown as import('kysely').Kysely<InventoryDatabase>,
      tenantId,
      ownerId,
      { name: 'Front counter', kind: 'warehouse', oversellPolicy: 'deny' },
    );
    const configured = await platform.app.request('/api/pos/settings', {
      method: 'PUT',
      headers: browserHeaders(tenantId, ownerCookie),
      body: JSON.stringify({ defaultLocationId: location.id, taxBps: 0 }),
    });
    expect(configured.status).toBe(200);

    const createdCashier = await platform.app.request('/api/pos/auth/operators', {
      method: 'POST',
      headers: browserHeaders(tenantId, ownerCookie),
      body: JSON.stringify({
        name: 'Casey Cashier',
        email: 'casey@local.invalid',
        role: 'cashier',
        pin: '1357',
      }),
    });
    expect(createdCashier.status).toBe(201);
    const cashier = (await json(createdCashier)).data;

    // The browser guard canonicalizes generic module attribution too; a valid
    // owner session cannot write a forged cashier into the orders audit trail.
    const genericOrder = await platform.app.request('/api/orders/orders', {
      method: 'POST',
      headers: browserHeaders(tenantId, ownerCookie, cashier.id),
      body: JSON.stringify({
        channel: 'manual',
        lines: [{ description: 'Generic routed sale', qty: 1, unitPriceCents: 1_000 }],
      }),
    });
    expect(genericOrder.status).toBe(201);
    const genericOrderBody = (await json(genericOrder)).data;
    const genericAudit = await db
      .selectFrom('audit_log')
      .select('actor')
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'orders.order.created')
      .where('entity_id', '=', genericOrderBody.id)
      .executeTakeFirstOrThrow();
    expect(genericAudit.actor).toBe(ownerId);

    await platform.app.request('/api/pos/auth/session', {
      method: 'DELETE',
      headers: browserHeaders(tenantId, ownerCookie),
    });
    const signIn = await platform.app.request('/api/pos/auth/session', {
      method: 'POST',
      headers: browserHeaders(tenantId),
      body: JSON.stringify({ userId: cashier.id, pin: '1357' }),
    });
    expect(signIn.status).toBe(201);
    const cashierCookie = cookieFrom(signIn);

    const wrongQueuedActor = await platform.app.request('/api/pos/readiness', {
      headers: {
        ...browserHeaders(tenantId, cashierCookie),
        'x-pos-expected-user-id': ownerId,
      },
    });
    expect(wrongQueuedActor.status).toBe(409);

    // A spoofed owner header never outranks the cashier's validated cookie.
    const adminRead = await platform.app.request('/api/admin/credentials', {
      headers: browserHeaders(tenantId, cashierCookie, ownerId),
    });
    expect(adminRead.status).toBe(403);
    const adminMutation = await platform.app.request('/api/pos/settings', {
      method: 'PUT',
      headers: browserHeaders(tenantId, cashierCookie, ownerId),
      body: JSON.stringify({ taxBps: 825 }),
    });
    expect(adminMutation.status).toBe(403);

    const opened = await platform.app.request('/api/pos/drawer/open', {
      method: 'POST',
      headers: browserHeaders(tenantId, cashierCookie, ownerId),
      body: JSON.stringify({ drawerRef: 'drawer-front', registerRef: 'front', openingFloatCents: 10_000 }),
    });
    expect(opened.status).toBe(201);
    expect((await json(opened)).data.session.opened_by).toBe(cashier.id);

    const spoofedOrder = await platform.app.request('/api/pos/orders', {
      method: 'POST',
      headers: browserHeaders(tenantId, cashierCookie, ownerId),
      body: JSON.stringify({
        cartId: 'spoofed-cashier-cart',
        cashierId: ownerId,
        lines: [{ description: 'Custom tack repair', qty: 1, unitPriceCents: 2_500 }],
      }),
    });
    expect(spoofedOrder.status).toBe(400);
    expect((await json(spoofedOrder)).error.message).toContain('signed-in register operator');

    const order = await platform.app.request('/api/pos/orders', {
      method: 'POST',
      headers: browserHeaders(tenantId, cashierCookie, ownerId),
      body: JSON.stringify({
        cartId: 'cashier-cart',
        registerId: 'front',
        lines: [{ description: 'Custom tack repair', qty: 1, unitPriceCents: 2_500 }],
      }),
    });
    expect(order.status).toBe(201);
    const orderBody = (await json(order)).data;
    expect(orderBody.cashier_id).toBe(cashier.id);

    const paid = await platform.app.request(`/api/pos/orders/${orderBody.id}/pay`, {
      method: 'POST',
      headers: browserHeaders(tenantId, cashierCookie, ownerId),
      body: JSON.stringify({
        tenders: [{
          kind: 'external',
          amountCents: 2_500,
          provider: 'manually_verified_other',
          providerRef: 'AUTH-TEST-1',
          idempotencyKey: 'auth-cashier-payment',
        }],
      }),
    });
    expect(paid.status).toBe(200);

    const tender = await db
      .selectFrom('orders_tenders')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderBody.id)
      .executeTakeFirstOrThrow();
    const line = await db
      .selectFrom('orders_lines')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderBody.id)
      .executeTakeFirstOrThrow();

    await platform.app.request('/api/pos/auth/session', {
      method: 'DELETE',
      headers: browserHeaders(tenantId, cashierCookie),
    });
    const ownerSignIn = await platform.app.request('/api/pos/auth/session', {
      method: 'POST',
      headers: browserHeaders(tenantId),
      body: JSON.stringify({ userId: ownerId, pin: '2468' }),
    });
    expect(ownerSignIn.status).toBe(201);
    const refreshedOwnerCookie = cookieFrom(ownerSignIn);

    const refund = await platform.app.request(`/api/pos/orders/${orderBody.id}/refunds`, {
      method: 'POST',
      headers: browserHeaders(tenantId, refreshedOwnerCookie, cashier.id),
      body: JSON.stringify({
        tenderId: tender.id,
        amountCents: 2_500,
        idempotencyKey: 'auth-owner-refund',
        reason: 'Authenticated attribution test',
        lines: [{ lineId: line.id, qty: 1, disposition: 'none' }],
      }),
    });
    expect(refund.status).toBe(201);
    const refundAudit = await db
      .selectFrom('audit_log')
      .select('actor')
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'orders.refund.created')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(refundAudit.actor).toBe(ownerId);
  });

  it('atomically locks an operator after five parallel wrong PIN attempts', async () => {
    const { db, platform, tenantId, ownerId } = await boot();
    await bootstrap(platform, tenantId);

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        platform.app.request('/api/pos/auth/session', {
          method: 'POST',
          headers: browserHeaders(tenantId),
          body: JSON.stringify({ userId: ownerId, pin: '9999' }),
        }),
      ),
    );
    expect(attempts.every((response) => response.status === 401)).toBe(true);

    const credential = await db
      .selectFrom('api_pos_credentials')
      .select(['failed_attempts', 'locked_until'])
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(credential.failed_attempts).toBe(0);
    expect(credential.locked_until).toBeTruthy();
    expect(Date.parse(String(credential.locked_until))).toBeGreaterThan(Date.now());

    const correctWhileLocked = await platform.app.request('/api/pos/auth/session', {
      method: 'POST',
      headers: browserHeaders(tenantId),
      body: JSON.stringify({ userId: ownerId, pin: '2468' }),
    });
    expect(correctWhileLocked.status).toBe(401);
    expect((await json(correctWhileLocked)).error.message).toContain('temporarily locked');
  });
});
