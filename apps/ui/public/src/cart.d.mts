export interface CartLine {
  id: string;
  variationId: string | null;
  description: string;
  sku: string | null;
  barcode: string | null;
  qty: number;
  unitPriceCents: number;
  discountBps: number;
  discountFixedCents: number;
  source: 'catalog' | 'custom';
}

export interface Cart {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  customerId: string | null;
  taxBps: number;
  discountBps: number;
  discountFixedCents: number;
  lines: CartLine[];
}

export interface HeldCart { id: string; name: string; heldAt: string; cart: Cart }
export interface PendingManualCheckout {
  paymentKind: 'manual';
  orderId: string;
  cartId: string;
  tenders: TenderPayload[];
  startedAt: string;
}
export interface PendingCardCheckout {
  paymentKind: 'card_present';
  orderId: string | null;
  cartId: string;
  orderIdempotencyKey: string;
  attemptIdempotencyKey: string;
  attemptId: string | null;
  amountCents?: number;
  awaitingPayment?: boolean;
  startedAt: string;
}
export type PendingCheckout = PendingManualCheckout | PendingCardCheckout;
export type PendingCheckoutInput = PendingCheckout | {
  paymentKind?: 'manual';
  orderId: string;
  cartId: string;
  tenders: TenderPayload[];
  startedAt: string;
};
export interface RegisterState {
  version: 1;
  active: Cart;
  holds: HeldCart[];
  pendingCheckout: PendingCheckout | null;
  registerId: string;
  drawerRef: string | null;
  cashSessionId: string | null;
}
export interface CartTotals {
  lineTotalsCents: number[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}
export interface CartLineInput {
  id?: string;
  variationId?: string | null;
  description: string;
  sku?: string | null;
  barcode?: string | null;
  qty: number;
  unitPriceCents: number;
  discountBps?: number;
  discountFixedCents?: number;
}
export interface ManualTenderInput {
  kind: 'cash' | 'external';
  amountCents: number;
  cashReceivedCents?: number;
  idempotencyKey?: string;
  provider?: string;
  providerRef?: string;
}
export interface TenderPayload extends ManualTenderInput { idempotencyKey: string }

export const CART_SCHEMA_VERSION: 1;
export const REGISTER_STORAGE_KEY: string;
export function createCart(options?: { id?: string; now?: string }): Cart;
export function parseMoneyToCents(value: unknown): number;
export function parsePercentToBps(value: unknown): number;
export function normalizeCart(value: unknown, options?: { id?: string; now?: string }): Cart;
export function addCartLine(cart: Cart, line: CartLineInput, options?: { lineId?: string; now?: string }): Cart;
export const addItem: typeof addCartLine;
export function setLineQuantity(cart: Cart, lineId: string, qty: number, options?: { now?: string }): Cart;
export function incrementLine(cart: Cart, lineId: string, options?: { now?: string }): Cart;
export function decrementLine(cart: Cart, lineId: string, options?: { now?: string }): Cart;
export function removeLine(cart: Cart, lineId: string, options?: { now?: string }): Cart;
export function setCustomer(cart: Cart, customerId: string | null, options?: { now?: string }): Cart;
export function setCartPricing(cart: Cart, pricing: { taxBps?: number; discountBps?: number; discountFixedCents?: number }, options?: { now?: string }): Cart;
export function cartTotals(cart: Cart): CartTotals;
export function cartItemCount(cart: Cart): number;
export function toOrderPayload(cart: Cart): Record<string, unknown>;
export function buildTenderPlan(totalCents: number, inputs: ManualTenderInput[], options?: { keyFactory?: (kind: string, index: number) => string }): TenderPayload[];
export function createRegisterState(options?: { active?: unknown; holds?: HeldCart[]; cartId?: string; now?: string; registerId?: string; drawerRef?: string | null; cashSessionId?: string | null }): RegisterState;
export function normalizeRegisterState(value: unknown, options?: { cartId?: string; now?: string; registerId?: string }): RegisterState;
export function holdActiveCart(state: RegisterState, options?: { name?: string; holdId?: string; nextCartId?: string; now?: string }): RegisterState;
export function resumeHeldCart(state: RegisterState, holdId: string, options?: { now?: string }): RegisterState;
export function removeHeldCart(state: RegisterState, holdId: string): RegisterState;
export function setPendingCheckout(state: RegisterState, pending: PendingCheckoutInput): RegisterState;
export function completePendingCheckout(state: RegisterState, options?: { nextCartId?: string; now?: string }): RegisterState;
export function clearPendingCheckout(state: RegisterState): RegisterState;
export function setRegisterContext(state: RegisterState, patch: { registerId?: string; drawerRef?: string | null; cashSessionId?: string | null }): RegisterState;
export function serializeRegisterState(state: RegisterState): string;
export function deserializeRegisterState(raw: string | null | undefined, options?: { cartId?: string; now?: string }): RegisterState;
