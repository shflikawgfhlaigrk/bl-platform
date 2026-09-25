/**
 * POS cart state and money math.
 *
 * This module is deliberately browser-independent: the register view owns
 * localStorage and network calls, while this file owns a versioned persistence
 * schema, immutable cart operations, and integer-cent calculations.
 */

export const CART_SCHEMA_VERSION = 1;
export const REGISTER_STORAGE_KEY = 'blacklabel.pos.register.v1';

const ALLOWED_TENDERS = new Set(['cash', 'external']);

function generatedId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function isoNow(value) {
  const raw = value || new Date().toISOString();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function rateBps(value, label) {
  nonnegativeInteger(value, label);
  if (value > 10000) throw new Error(`${label} must be between 0 and 10000 basis points`);
  return value;
}

function textOrNull(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function applyDiscount(amountCents, bps, fixedCents) {
  let amount = nonnegativeInteger(amountCents, 'amountCents');
  const percent = rateBps(bps || 0, 'discountBps');
  const fixed = nonnegativeInteger(fixedCents || 0, 'discountFixedCents');
  amount -= Math.round((amount * percent) / 10000);
  return Math.max(0, amount - fixed);
}

function touch(cart, patch, now) {
  return { ...cart, ...patch, updatedAt: isoNow(now) };
}

/** Create a buyer-empty cart. Optional ids/times make tests deterministic. */
export function createCart(options = {}) {
  const now = isoNow(options.now);
  return {
    version: CART_SCHEMA_VERSION,
    id: textOrNull(options.id) || generatedId('cart'),
    createdAt: now,
    updatedAt: now,
    customerId: null,
    taxBps: 0,
    discountBps: 0,
    discountFixedCents: 0,
    lines: [],
  };
}

/** Parse a dollars input without floating-point dollar arithmetic. */
export function parseMoneyToCents(value) {
  const raw = String(value ?? '').trim().replace(/[$,\s]/g, '');
  const match = raw.match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) throw new Error('Enter a non-negative amount with no more than two decimal places');
  const dollars = Number(match[1]);
  const fraction = (match[2] || '').padEnd(2, '0');
  const cents = dollars * 100 + Number(fraction || 0);
  if (!Number.isSafeInteger(cents)) throw new Error('Amount is too large');
  return cents;
}

/** Parse a percent input (for example "8.25") into basis points. */
export function parsePercentToBps(value) {
  const raw = String(value ?? '').trim().replace(/%\s*$/, '');
  const match = raw.match(/^(\d{1,3})(?:\.(\d{0,2}))?$/);
  if (!match) throw new Error('Enter a percent from 0 to 100 with up to two decimal places');
  const bps = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0') || 0);
  return rateBps(bps, 'percent');
}

function normalizeLine(line) {
  if (!line || typeof line !== 'object') return null;
  const description = textOrNull(line.description);
  if (!description) return null;
  try {
    const qty = positiveInteger(line.qty, 'qty');
    const unitPriceCents = nonnegativeInteger(line.unitPriceCents, 'unitPriceCents');
    const discountBps = rateBps(line.discountBps || 0, 'discountBps');
    const discountFixedCents = nonnegativeInteger(line.discountFixedCents || 0, 'discountFixedCents');
    return {
      id: textOrNull(line.id) || generatedId('line'),
      variationId: textOrNull(line.variationId),
      description,
      sku: textOrNull(line.sku),
      barcode: textOrNull(line.barcode),
      qty,
      unitPriceCents,
      discountBps,
      discountFixedCents,
      source: line.source === 'catalog' && textOrNull(line.variationId) ? 'catalog' : 'custom',
    };
  } catch {
    return null;
  }
}

/** Normalize persisted/untrusted data. Invalid fields become safe empty defaults. */
export function normalizeCart(value, options = {}) {
  if (!value || typeof value !== 'object' || value.version !== CART_SCHEMA_VERSION) {
    return createCart(options);
  }
  const fallback = createCart(options);
  const lines = Array.isArray(value.lines) ? value.lines.map(normalizeLine).filter(Boolean) : [];
  const safeRate = (candidate) => {
    try { return rateBps(candidate || 0, 'rate'); } catch { return 0; }
  };
  const safeCents = (candidate) => {
    try { return nonnegativeInteger(candidate || 0, 'cents'); } catch { return 0; }
  };
  return {
    version: CART_SCHEMA_VERSION,
    id: textOrNull(value.id) || fallback.id,
    createdAt: isoNow(value.createdAt || fallback.createdAt),
    updatedAt: isoNow(value.updatedAt || fallback.updatedAt),
    customerId: textOrNull(value.customerId),
    taxBps: safeRate(value.taxBps),
    discountBps: safeRate(value.discountBps),
    discountFixedCents: safeCents(value.discountFixedCents),
    lines,
  };
}

/** Add a catalog/custom line. Matching catalog variations aggregate quantity. */
export function addCartLine(cartInput, lineInput, options = {}) {
  const cart = normalizeCart(cartInput);
  const normalized = normalizeLine({
    ...lineInput,
    id: options.lineId || lineInput?.id,
    source: textOrNull(lineInput?.variationId) ? 'catalog' : 'custom',
  });
  if (!normalized) throw new Error('A cart line needs a description, positive quantity, and integer-cent price');

  const matchIndex = normalized.variationId
    ? cart.lines.findIndex((line) =>
        line.variationId === normalized.variationId &&
        line.unitPriceCents === normalized.unitPriceCents &&
        line.discountBps === normalized.discountBps &&
        line.discountFixedCents === normalized.discountFixedCents)
    : -1;
  if (matchIndex >= 0) {
    const lines = cart.lines.map((line, index) =>
      index === matchIndex ? { ...line, qty: line.qty + normalized.qty } : line,
    );
    return touch(cart, { lines }, options.now);
  }
  return touch(cart, { lines: [...cart.lines, normalized] }, options.now);
}

export const addItem = addCartLine;

/** Set quantity; zero removes the line. */
export function setLineQuantity(cartInput, lineId, qty, options = {}) {
  const cart = normalizeCart(cartInput);
  if (!cart.lines.some((line) => line.id === lineId)) return cart;
  if (!Number.isSafeInteger(qty) || qty < 0) throw new Error('qty must be a non-negative integer');
  const lines = qty === 0
    ? cart.lines.filter((line) => line.id !== lineId)
    : cart.lines.map((line) => (line.id === lineId ? { ...line, qty } : line));
  return touch(cart, { lines }, options.now);
}

export function incrementLine(cart, lineId, options = {}) {
  const line = normalizeCart(cart).lines.find((item) => item.id === lineId);
  return line ? setLineQuantity(cart, lineId, line.qty + 1, options) : normalizeCart(cart);
}

export function decrementLine(cart, lineId, options = {}) {
  const line = normalizeCart(cart).lines.find((item) => item.id === lineId);
  return line ? setLineQuantity(cart, lineId, Math.max(0, line.qty - 1), options) : normalizeCart(cart);
}

export function removeLine(cartInput, lineId, options = {}) {
  return setLineQuantity(cartInput, lineId, 0, options);
}

export function setCustomer(cartInput, customerId, options = {}) {
  const cart = normalizeCart(cartInput);
  return touch(cart, { customerId: textOrNull(customerId) }, options.now);
}

export function setCartPricing(cartInput, pricing, options = {}) {
  const cart = normalizeCart(cartInput);
  const patch = {};
  if (pricing.taxBps !== undefined) patch.taxBps = rateBps(pricing.taxBps, 'taxBps');
  if (pricing.discountBps !== undefined) patch.discountBps = rateBps(pricing.discountBps, 'discountBps');
  if (pricing.discountFixedCents !== undefined) {
    patch.discountFixedCents = nonnegativeInteger(pricing.discountFixedCents, 'discountFixedCents');
  }
  return touch(cart, patch, options.now);
}

/** Canonical POS totals: line discounts, order discount, then tax. */
export function cartTotals(cartInput) {
  const cart = normalizeCart(cartInput);
  const lineTotalsCents = cart.lines.map((line) => {
    const gross = Math.round(line.qty * line.unitPriceCents);
    return applyDiscount(gross, line.discountBps, line.discountFixedCents);
  });
  const subtotalCents = lineTotalsCents.reduce((sum, value) => sum + value, 0);
  const discountedCents = applyDiscount(subtotalCents, cart.discountBps, cart.discountFixedCents);
  const discountCents = subtotalCents - discountedCents;
  const taxCents = Math.round((discountedCents * cart.taxBps) / 10000);
  return {
    lineTotalsCents,
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: discountedCents + taxCents,
  };
}

export function cartItemCount(cartInput) {
  return normalizeCart(cartInput).lines.reduce((sum, line) => sum + line.qty, 0);
}

/** Convert the cart to the existing orders POST /orders API contract. */
export function toOrderPayload(cartInput) {
  const cart = normalizeCart(cartInput);
  if (!cart.lines.length) throw new Error('Cart is empty');
  const payload = {
    cartId: cart.id,
    channel: 'pos',
    lines: cart.lines.map((line) => {
      const out = {
        description: line.description,
        qty: line.qty,
        unitPriceCents: line.unitPriceCents,
      };
      if (line.variationId) out.variationId = line.variationId;
      if (line.discountBps) out.discountBps = line.discountBps;
      if (line.discountFixedCents) out.discountFixedCents = line.discountFixedCents;
      return out;
    }),
    taxBps: cart.taxBps,
  };
  if (cart.customerId) payload.customerId = cart.customerId;
  if (cart.discountBps) payload.discountBps = cart.discountBps;
  if (cart.discountFixedCents) payload.discountFixedCents = cart.discountFixedCents;
  return payload;
}

/**
 * Validate and construct manual tender payloads. Card/provider tenders are not
 * accepted here: only a real provider flow may claim those were captured.
 */
export function buildTenderPlan(totalCents, inputs, options = {}) {
  nonnegativeInteger(totalCents, 'totalCents');
  if (!Array.isArray(inputs)) throw new Error('Tenders must be an array');
  if (totalCents === 0 && inputs.length === 0) return [];
  if (inputs.length === 0) throw new Error('At least one tender is required');
  const keyFactory = options.keyFactory || (() => generatedId('tender'));
  const tenders = inputs.map((input, index) => {
    if (!ALLOWED_TENDERS.has(input.kind)) throw new Error(`Unsupported manual tender: ${input.kind}`);
    const amountCents = positiveInteger(input.amountCents, `tender ${index + 1} amountCents`);
    const out = {
      kind: input.kind,
      amountCents,
      idempotencyKey: textOrNull(input.idempotencyKey) || keyFactory(input.kind, index),
    };
    if (input.kind === 'cash') {
      const cashReceivedCents = input.cashReceivedCents === undefined
        ? amountCents
        : nonnegativeInteger(input.cashReceivedCents, `tender ${index + 1} cashReceivedCents`);
      if (cashReceivedCents < amountCents) throw new Error('Cash received must be at least the cash tender amount');
      out.cashReceivedCents = cashReceivedCents;
    } else if (input.cashReceivedCents !== undefined) {
      throw new Error('cashReceivedCents is only valid for cash tenders');
    }
    const provider = textOrNull(input.provider);
    const providerRef = textOrNull(input.providerRef);
    if (provider) out.provider = provider;
    if (providerRef) out.providerRef = providerRef;
    return out;
  });
  const paid = tenders.reduce((sum, tender) => sum + tender.amountCents, 0);
  if (paid !== totalCents) {
    throw new Error(`Tender total (${paid}) must exactly equal sale total (${totalCents})`);
  }
  return tenders;
}

export function createRegisterState(options = {}) {
  return {
    version: CART_SCHEMA_VERSION,
    active: normalizeCart(options.active, { id: options.cartId, now: options.now }),
    holds: Array.isArray(options.holds) ? options.holds : [],
    pendingCheckout: null,
    registerId: textOrNull(options.registerId) || generatedId('register'),
    drawerRef: textOrNull(options.drawerRef),
    cashSessionId: textOrNull(options.cashSessionId),
  };
}

function normalizeHold(value) {
  if (!value || typeof value !== 'object') return null;
  const id = textOrNull(value.id);
  if (!id) return null;
  const cart = normalizeCart(value.cart);
  if (!cart.lines.length) return null;
  return {
    id,
    name: textOrNull(value.name) || 'Held cart',
    heldAt: isoNow(value.heldAt),
    cart,
  };
}

export function normalizeRegisterState(value, options = {}) {
  if (!value || typeof value !== 'object' || value.version !== CART_SCHEMA_VERSION) {
    return createRegisterState(options);
  }
  return {
    version: CART_SCHEMA_VERSION,
    active: normalizeCart(value.active, { id: options.cartId, now: options.now }),
    holds: Array.isArray(value.holds) ? value.holds.map(normalizeHold).filter(Boolean) : [],
    pendingCheckout: normalizePendingCheckout(value.pendingCheckout),
    registerId: textOrNull(value.registerId) || textOrNull(options.registerId) || generatedId('register'),
    drawerRef: textOrNull(value.drawerRef),
    cashSessionId: textOrNull(value.cashSessionId),
  };
}

function normalizePendingCheckout(value) {
  if (!value || typeof value !== 'object') return null;
  const cartId = textOrNull(value.cartId);
  if (!cartId) return null;
  if (value.paymentKind === 'card_present') {
    const orderIdempotencyKey = textOrNull(value.orderIdempotencyKey);
    const attemptIdempotencyKey = textOrNull(value.attemptIdempotencyKey);
    if (!orderIdempotencyKey || !attemptIdempotencyKey) return null;
    return {
      paymentKind: 'card_present',
      orderId: textOrNull(value.orderId),
      cartId,
      orderIdempotencyKey,
      attemptIdempotencyKey,
      attemptId: textOrNull(value.attemptId),
      ...(Number.isSafeInteger(value.amountCents) && value.amountCents > 0 ? { amountCents: value.amountCents } : {}),
      ...(value.awaitingPayment === true ? { awaitingPayment: true } : {}),
      startedAt: isoNow(value.startedAt),
    };
  }
  const orderId = textOrNull(value.orderId);
  if (!orderId || !Array.isArray(value.tenders)) return null;
  try {
    const tenders = value.tenders.map((tender, index) => {
      if (!ALLOWED_TENDERS.has(tender.kind)) throw new Error('unsupported tender');
      return {
        kind: tender.kind,
        amountCents: positiveInteger(tender.amountCents, `tender ${index + 1}`),
        ...(tender.kind === 'cash'
          ? { cashReceivedCents: normalizeCashReceived(tender.cashReceivedCents, tender.amountCents) }
          : {}),
        idempotencyKey: textOrNull(tender.idempotencyKey) || (() => { throw new Error('missing idempotency key'); })(),
        ...(textOrNull(tender.provider) ? { provider: textOrNull(tender.provider) } : {}),
        ...(textOrNull(tender.providerRef) ? { providerRef: textOrNull(tender.providerRef) } : {}),
      };
    });
    return { paymentKind: 'manual', orderId, cartId, tenders, startedAt: isoNow(value.startedAt) };
  } catch {
    return null;
  }
}

function normalizeCashReceived(value, amountCents) {
  const received = value === undefined ? amountCents : nonnegativeInteger(value, 'cashReceivedCents');
  if (received < amountCents) throw new Error('cashReceivedCents is below the tender amount');
  return received;
}

export function holdActiveCart(stateInput, options = {}) {
  const state = normalizeRegisterState(stateInput);
  if (!state.active.lines.length) throw new Error('Cart is empty');
  const heldAt = isoNow(options.now);
  const hold = {
    id: textOrNull(options.holdId) || generatedId('hold'),
    name: textOrNull(options.name) || `Held ${heldAt}`,
    heldAt,
    cart: state.active,
  };
  return {
    version: CART_SCHEMA_VERSION,
    active: createCart({ id: options.nextCartId, now: heldAt }),
    holds: [...state.holds, hold],
    pendingCheckout: null,
    registerId: state.registerId,
    drawerRef: state.drawerRef,
    cashSessionId: state.cashSessionId,
  };
}

/** Resume requires an empty active cart so no sale is silently overwritten. */
export function resumeHeldCart(stateInput, holdId, options = {}) {
  const state = normalizeRegisterState(stateInput);
  if (state.active.lines.length) throw new Error('Hold or clear the active cart before resuming another cart');
  const hold = state.holds.find((item) => item.id === holdId);
  if (!hold) throw new Error('Held cart was not found');
  return {
    version: CART_SCHEMA_VERSION,
    active: touch(hold.cart, {}, options.now),
    holds: state.holds.filter((item) => item.id !== holdId),
    pendingCheckout: null,
    registerId: state.registerId,
    drawerRef: state.drawerRef,
    cashSessionId: state.cashSessionId,
  };
}

export function removeHeldCart(stateInput, holdId) {
  const state = normalizeRegisterState(stateInput);
  return { ...state, holds: state.holds.filter((item) => item.id !== holdId) };
}

export function setPendingCheckout(stateInput, pending) {
  const state = normalizeRegisterState(stateInput);
  const normalized = normalizePendingCheckout(pending);
  if (!normalized) throw new Error('Pending checkout is invalid');
  if (normalized.cartId !== state.active.id) throw new Error('Pending checkout does not belong to the active cart');
  return { ...state, pendingCheckout: normalized };
}

export function completePendingCheckout(stateInput, options = {}) {
  const state = normalizeRegisterState(stateInput);
  return {
    ...state,
    active: { ...createCart({ id: options.nextCartId, now: options.now }), taxBps: state.active.taxBps },
    pendingCheckout: null,
  };
}

/** Release a terminal/non-started recovery while preserving the active cart. */
export function clearPendingCheckout(stateInput) {
  const state = normalizeRegisterState(stateInput);
  return { ...state, pendingCheckout: null };
}

export function setRegisterContext(stateInput, patch) {
  const state = normalizeRegisterState(stateInput);
  return {
    ...state,
    registerId: textOrNull(patch.registerId) || state.registerId,
    drawerRef: patch.drawerRef !== undefined ? textOrNull(patch.drawerRef) : state.drawerRef,
    cashSessionId: patch.cashSessionId !== undefined ? textOrNull(patch.cashSessionId) : state.cashSessionId,
  };
}

export function serializeRegisterState(state) {
  return JSON.stringify(normalizeRegisterState(state));
}

export function deserializeRegisterState(raw, options = {}) {
  if (!raw) return createRegisterState(options);
  try {
    return normalizeRegisterState(JSON.parse(raw), options);
  } catch {
    return createRegisterState(options);
  }
}
