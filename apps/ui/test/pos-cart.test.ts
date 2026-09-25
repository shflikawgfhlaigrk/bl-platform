import { describe, expect, it } from 'vitest';
import * as Cart from '../public/src/cart.mjs';

const NOW = '2026-09-03T10:00:00.000Z';

function empty() {
  return Cart.createCart({ id: 'cart_1', now: NOW });
}

describe('POS cart integer-cent math', () => {
  it('starts buyer-empty and adds catalog lines without mutating input', () => {
    const original = empty();
    const added = Cart.addCartLine(original, {
      variationId: 'variation_1',
      description: 'Blue shirt',
      sku: 'BLUE-S',
      qty: 1,
      unitPriceCents: 2599,
    }, { lineId: 'line_1', now: NOW });

    expect(original.lines).toEqual([]);
    expect(added.lines).toHaveLength(1);
    expect(added.lines[0]).toMatchObject({
      id: 'line_1',
      variationId: 'variation_1',
      qty: 1,
      unitPriceCents: 2599,
      source: 'catalog',
    });
  });

  it('aggregates the same catalog variation and keeps custom lines distinct', () => {
    let cart = Cart.addCartLine(empty(), {
      variationId: 'v1', description: 'Catalog item', qty: 1, unitPriceCents: 1000,
    }, { lineId: 'catalog_line' });
    cart = Cart.addCartLine(cart, {
      variationId: 'v1', description: 'Catalog item', qty: 2, unitPriceCents: 1000,
    });
    cart = Cart.addCartLine(cart, { description: 'Custom', qty: 1, unitPriceCents: 1000 }, { lineId: 'custom_1' });
    cart = Cart.addCartLine(cart, { description: 'Custom', qty: 1, unitPriceCents: 1000 }, { lineId: 'custom_2' });

    expect(cart.lines).toHaveLength(3);
    expect(cart.lines[0].qty).toBe(3);
    expect(cart.lines.slice(1).map((line) => line.id)).toEqual(['custom_1', 'custom_2']);
  });

  it('increments, decrements, and removes by stable line id', () => {
    let cart = Cart.addCartLine(empty(), { description: 'A', qty: 1, unitPriceCents: 500 }, { lineId: 'a' });
    cart = Cart.incrementLine(cart, 'a');
    expect(cart.lines[0].qty).toBe(2);
    cart = Cart.decrementLine(cart, 'a');
    expect(cart.lines[0].qty).toBe(1);
    cart = Cart.decrementLine(cart, 'a');
    expect(cart.lines).toEqual([]);
  });

  it('applies line discount, order discount, then tax with integer cents', () => {
    let cart = Cart.addCartLine(empty(), {
      description: 'A', qty: 2, unitPriceCents: 5000, discountBps: 1000,
    }, { lineId: 'a' });
    cart = Cart.setCartPricing(cart, { discountFixedCents: 500, taxBps: 800 });
    expect(Cart.cartTotals(cart)).toEqual({
      lineTotalsCents: [9000],
      subtotalCents: 9000,
      discountCents: 500,
      taxCents: 680,
      totalCents: 9180,
    });
  });

  it('parses operator money and percent fields without dollar floats', () => {
    expect(Cart.parseMoneyToCents('$1,234.56')).toBe(123456);
    expect(Cart.parseMoneyToCents('9')).toBe(900);
    expect(Cart.parseMoneyToCents('0.05')).toBe(5);
    expect(Cart.parsePercentToBps('8.25%')).toBe(825);
    expect(Cart.parsePercentToBps('100')).toBe(10000);
    expect(() => Cart.parseMoneyToCents('1.234')).toThrow(/two decimal/);
    expect(() => Cart.parsePercentToBps('100.01')).toThrow(/between 0 and 10000/);
  });

  it('builds the existing camelCase order API payload', () => {
    let cart = Cart.addCartLine(empty(), {
      variationId: 'v1', description: 'One', qty: 2, unitPriceCents: 1250,
    }, { lineId: 'line_1' });
    cart = Cart.addCartLine(cart, { description: 'Service', qty: 1, unitPriceCents: 500 }, { lineId: 'line_2' });
    cart = Cart.setCustomer(cart, 'customer_1');
    cart = Cart.setCartPricing(cart, { taxBps: 825, discountBps: 500, discountFixedCents: 25 });

    expect(Cart.toOrderPayload(cart)).toEqual({
      cartId: 'cart_1',
      channel: 'pos',
      customerId: 'customer_1',
      discountBps: 500,
      discountFixedCents: 25,
      taxBps: 825,
      lines: [
        { variationId: 'v1', description: 'One', qty: 2, unitPriceCents: 1250 },
        { description: 'Service', qty: 1, unitPriceCents: 500 },
      ],
    });
  });
});

describe('POS cart persistence and tender safety', () => {
  it('round-trips versioned active and held carts', () => {
    let state = Cart.createRegisterState({ cartId: 'cart_a', registerId: 'register_1', now: NOW });
    state = { ...state, active: Cart.addCartLine(state.active, { description: 'Held item', qty: 2, unitPriceCents: 750 }, { lineId: 'line_a', now: NOW }) };
    state = Cart.holdActiveCart(state, { name: 'Pickup', holdId: 'hold_1', nextCartId: 'cart_b', now: NOW });

    const restored = Cart.deserializeRegisterState(Cart.serializeRegisterState(state));
    expect(restored.version).toBe(Cart.CART_SCHEMA_VERSION);
    expect(restored.active.id).toBe('cart_b');
    expect(restored.active.lines).toEqual([]);
    expect(restored.registerId).toBe('register_1');
    expect(restored.holds[0]).toMatchObject({ id: 'hold_1', name: 'Pickup' });
    expect(restored.holds[0].cart.lines[0]).toMatchObject({ id: 'line_a', qty: 2, unitPriceCents: 750 });
  });

  it('persists the physical drawer context without putting it in a cart line', () => {
    let state = Cart.createRegisterState({ cartId: 'cart_1', registerId: 'register_1', now: NOW });
    state = Cart.setRegisterContext(state, { drawerRef: 'front-drawer', cashSessionId: 'shift_1' });
    const restored = Cart.deserializeRegisterState(Cart.serializeRegisterState(state));
    expect(restored).toMatchObject({
      registerId: 'register_1',
      drawerRef: 'front-drawer',
      cashSessionId: 'shift_1',
    });
    expect(restored.active).not.toHaveProperty('cashSessionId');
  });

  it('never overwrites a non-empty active cart when resuming a hold', () => {
    let state = Cart.createRegisterState({ cartId: 'held_cart', now: NOW });
    state = { ...state, active: Cart.addCartLine(state.active, { description: 'Held', qty: 1, unitPriceCents: 100 }, { lineId: 'held_line' }) };
    state = Cart.holdActiveCart(state, { holdId: 'hold_1', nextCartId: 'active_cart', now: NOW });
    state = { ...state, active: Cart.addCartLine(state.active, { description: 'Current', qty: 1, unitPriceCents: 200 }, { lineId: 'current_line' }) };
    expect(() => Cart.resumeHeldCart(state, 'hold_1')).toThrow(/Hold or clear/);
  });

  it('persists a pending server order for idempotent payment recovery', () => {
    let state = Cart.createRegisterState({ cartId: 'cart_1', now: NOW });
    state = { ...state, active: Cart.addCartLine(state.active, { description: 'A', qty: 1, unitPriceCents: 1000 }, { lineId: 'a' }) };
    state = Cart.setPendingCheckout(state, {
      orderId: 'order_1', cartId: 'cart_1', startedAt: NOW,
      tenders: [{ kind: 'cash', amountCents: 1000, idempotencyKey: 'idem_1' }],
    });
    const restored = Cart.deserializeRegisterState(Cart.serializeRegisterState(state));
    expect(restored.pendingCheckout).toMatchObject({ paymentKind: 'manual', orderId: 'order_1', cartId: 'cart_1' });
    if (restored.pendingCheckout?.paymentKind !== 'manual') throw new Error('manual pending checkout was not restored');
    expect(restored.pendingCheckout.tenders[0].idempotencyKey).toBe('idem_1');
    const completed = Cart.completePendingCheckout(restored, { nextCartId: 'cart_2', now: NOW });
    expect(completed.pendingCheckout).toBeNull();
    expect(completed.active).toMatchObject({ id: 'cart_2', lines: [] });
  });

  it('round-trips a card-present recovery before and after an attempt id is known', () => {
    let state = Cart.createRegisterState({ cartId: 'cart_card', registerId: 'register_1', now: NOW });
    state = { ...state, active: Cart.addCartLine(state.active, { description: 'A', qty: 1, unitPriceCents: 1000 }, { lineId: 'a' }) };
    state = Cart.setPendingCheckout(state, {
      paymentKind: 'card_present',
      orderId: null,
      cartId: 'cart_card',
      orderIdempotencyKey: 'order-idem',
      attemptIdempotencyKey: 'attempt-idem',
      attemptId: null,
      startedAt: NOW,
    });

    let restored = Cart.deserializeRegisterState(Cart.serializeRegisterState(state));
    expect(restored.pendingCheckout).toEqual({
      paymentKind: 'card_present',
      orderId: null,
      cartId: 'cart_card',
      orderIdempotencyKey: 'order-idem',
      attemptIdempotencyKey: 'attempt-idem',
      attemptId: null,
      startedAt: NOW,
    });
    if (restored.pendingCheckout?.paymentKind !== 'card_present') throw new Error('card pending checkout was not restored');
    restored = Cart.setPendingCheckout(restored, {
      ...restored.pendingCheckout,
      orderId: 'order_card',
      attemptId: 'attempt_card',
    });
    expect(Cart.deserializeRegisterState(Cart.serializeRegisterState(restored)).pendingCheckout).toMatchObject({
      paymentKind: 'card_present',
      orderId: 'order_card',
      orderIdempotencyKey: 'order-idem',
      attemptIdempotencyKey: 'attempt-idem',
      attemptId: 'attempt_card',
    });
  });

  it('releases terminal card recovery without clearing or replacing the active cart', () => {
    let state = Cart.createRegisterState({ cartId: 'cart_card', now: NOW });
    state = { ...state, active: Cart.addCartLine(state.active, { description: 'A', qty: 1, unitPriceCents: 1000 }, { lineId: 'a' }) };
    state = Cart.setPendingCheckout(state, {
      paymentKind: 'card_present',
      orderId: 'order_card',
      cartId: 'cart_card',
      orderIdempotencyKey: 'order-idem',
      attemptIdempotencyKey: 'attempt-idem',
      attemptId: 'attempt_card',
      startedAt: NOW,
    });
    const released = Cart.clearPendingCheckout(state);
    expect(released.pendingCheckout).toBeNull();
    expect(released.active).toEqual(state.active);
  });

  it('fails closed to an empty buyer state for malformed storage', () => {
    const state = Cart.deserializeRegisterState('{not json', { cartId: 'safe', now: NOW });
    expect(state.active).toMatchObject({ id: 'safe', lines: [], customerId: null });
    expect(state.holds).toEqual([]);
    expect(state.pendingCheckout).toBeNull();
  });

  it('requires exact cash/external tender totals and rejects fake card capture', () => {
    expect(Cart.buildTenderPlan(5000, [
      { kind: 'cash', amountCents: 2000 },
      { kind: 'external', amountCents: 3000, providerRef: 'receipt-1' },
    ], { keyFactory: (kind, index) => `${kind}-${index}` })).toEqual([
      { kind: 'cash', amountCents: 2000, cashReceivedCents: 2000, idempotencyKey: 'cash-0' },
      { kind: 'external', amountCents: 3000, providerRef: 'receipt-1', idempotencyKey: 'external-1' },
    ]);
    expect(() => Cart.buildTenderPlan(5000, [{ kind: 'cash', amountCents: 4999 }])).toThrow(/exactly equal/);
    expect(() => Cart.buildTenderPlan(5000, [{ kind: 'card', amountCents: 5000 } as any])).toThrow(/Unsupported manual tender/);
    expect(Cart.buildTenderPlan(0, [])).toEqual([]);
  });

  it('preserves cash received for server-calculated change and recovery', () => {
    const plan = Cart.buildTenderPlan(2500, [
      { kind: 'cash', amountCents: 2500, cashReceivedCents: 3000 },
    ], { keyFactory: () => 'cash-idem' });
    expect(plan).toEqual([{
      kind: 'cash', amountCents: 2500, cashReceivedCents: 3000, idempotencyKey: 'cash-idem',
    }]);
    expect(() => Cart.buildTenderPlan(2500, [
      { kind: 'cash', amountCents: 2500, cashReceivedCents: 2499 },
    ])).toThrow(/at least/);
  });
});

it('preserves a split portion and the awaiting-next-payment state across reloads', () => {
  let state = Cart.createRegisterState({ cartId: 'split-reload' });
  state = Cart.setPendingCheckout(state, { paymentKind: 'card_present', orderId: 'order-split', cartId: state.active.id,
    orderIdempotencyKey: 'order-key', attemptIdempotencyKey: 'portion-key', attemptId: 'attempt-1',
    amountCents: 1275, awaitingPayment: true, startedAt: NOW });
  const restored = Cart.deserializeRegisterState(Cart.serializeRegisterState(state));
  expect(restored.pendingCheckout).toEqual(state.pendingCheckout);
  expect(restored.pendingCheckout).toMatchObject({ amountCents: 1275, awaitingPayment: true, attemptIdempotencyKey: 'portion-key' });
});

it('keeps the configured tax rate on a new sale after payment completion', () => {
  let state = Cart.createRegisterState({ cartId: 'tax-carry' });
  state = { ...state, active: Cart.setCartPricing(state.active, { taxBps: 825, discountBps: 1000 }) };
  const next = Cart.completePendingCheckout(state);
  expect(next.active).toMatchObject({ taxBps: 825, discountBps: 0, lines: [] });
  const nextItem = Cart.addCartLine(next.active, { description: 'Next item', qty: 1, unitPriceCents: 10_000 });
  expect(Cart.cartTotals(nextItem).totalCents).toBe(10_825);
});
