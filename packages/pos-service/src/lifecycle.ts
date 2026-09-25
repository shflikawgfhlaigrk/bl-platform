/**
 * The merchant lifecycle, from purchase to live. Stages only move forward; a problem is recorded
 * as a `blocked` condition on the current stage, never as a step backwards.
 */

export const MERCHANT_STAGES = [
  'purchased',
  'account_created',
  'onboarding',
  'verified',
  'location_ready',
  'reader_ordered',
  'reader_shipped',
  'reader_delivered',
  'reader_registered',
  'test_sale',
  'live',
] as const;

export type MerchantStage = (typeof MERCHANT_STAGES)[number];

export function stageRank(stage: MerchantStage): number {
  return MERCHANT_STAGES.indexOf(stage);
}

export function isAtLeast(stage: MerchantStage, target: MerchantStage): boolean {
  return stageRank(stage) >= stageRank(target);
}

export interface MerchantAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: 'US';
}

export type CardPaymentsStatus = 'active' | 'pending' | 'restricted' | 'unsupported' | 'unrequested' | 'unknown';

export interface DueRequirement {
  description: string;
  deadline: 'currently_due' | 'past_due';
  errors: string[];
}

export interface PreparedMessage {
  id: string;
  kind: 'onboarding_link' | 'requirements_due' | 'reader_shipped' | 'reader_delivered' | 'hardware_problem' | 'go_live';
  to: string;
  subject: string;
  body: string;
  preparedAt: string;
  /** This package prepares messages; the platform mailer sends them and records the send. */
  sentAt: string | null;
}

export interface StageChange {
  at: string;
  from: MerchantStage;
  to: MerchantStage;
  note: string;
}

export interface MerchantRecord {
  id: string;
  version: number;
  livemode: boolean;
  purchaseRef: string;
  businessName: string;
  contactEmail: string;
  address: MerchantAddress;
  stage: MerchantStage;
  blocked: { code: string; detail: string; at: string } | null;
  stripeAccountId: string | null;
  cardPayments: CardPaymentsStatus;
  requirementsDue: DueRequirement[];
  onboardingLink: { url: string; expiresAt: string | null } | null;
  locationId: string | null;
  hardwareOrder: { id: string; status: string; tracking: Array<{ carrier: string | null; trackingNumber: string | null }> } | null;
  reader: { id: string; deviceType: string; label: string } | null;
  testSale: {
    attempt: number;
    paymentIntentId: string | null;
    status: 'not_started' | 'waiting_for_card' | 'captured' | 'refunded' | 'failed';
    refundId: string | null;
    failure: string | null;
  };
  messages: PreparedMessage[];
  history: StageChange[];
  createdAt: string;
  updatedAt: string;
}

type Obj = Record<string, unknown>;
const asObj = (value: unknown): Obj | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null);

/** Read `configuration.merchant.capabilities.card_payments.status` from a v2 Account. */
export function readCardPaymentsStatus(account: unknown): CardPaymentsStatus {
  const merchant = asObj(asObj(asObj(account)?.configuration)?.merchant);
  if (!merchant) return 'unknown';
  const cardPayments = asObj(asObj(merchant.capabilities)?.card_payments);
  if (!cardPayments) return 'unrequested';
  const status = cardPayments.status;
  return status === 'active' || status === 'pending' || status === 'restricted' || status === 'unsupported' ? status : 'unknown';
}

/** Requirements the merchant must act on now (`awaiting_action_from: user`, currently or past due). */
export function readUserRequirements(account: unknown): DueRequirement[] {
  const entries = asObj(asObj(account)?.requirements)?.entries;
  if (!Array.isArray(entries)) return [];
  const due: DueRequirement[] = [];
  for (const raw of entries) {
    const entry = asObj(raw);
    if (!entry || entry.awaiting_action_from !== 'user') continue;
    const deadline = asObj(entry.minimum_deadline)?.status;
    if (deadline !== 'currently_due' && deadline !== 'past_due') continue;
    due.push({
      description: typeof entry.description === 'string' ? entry.description : 'unspecified requirement',
      deadline,
      errors: Array.isArray(entry.errors)
        ? entry.errors.map((e) => asObj(e)?.code).filter((code): code is string => typeof code === 'string')
        : [],
    });
  }
  return due;
}

export const HARDWARE_ORDER_STATUSES = ['pending', 'ready_to_ship', 'shipped', 'delivered', 'canceled', 'undeliverable'] as const;
export type HardwareOrderStatus = (typeof HARDWARE_ORDER_STATUSES)[number];

export interface HardwareOrderSnapshot {
  id: string;
  status: HardwareOrderStatus;
  tracking: Array<{ carrier: string | null; trackingNumber: string | null }>;
}

/** Validate a Terminal Hardware Order object (API reference fields: id, status, shipment_tracking). */
export function readHardwareOrder(order: unknown): HardwareOrderSnapshot | null {
  const o = asObj(order);
  if (!o || typeof o.id !== 'string' || !o.id.startsWith('thor_')) return null;
  if (!HARDWARE_ORDER_STATUSES.includes(o.status as HardwareOrderStatus)) return null;
  const tracking = Array.isArray(o.shipment_tracking)
    ? o.shipment_tracking.map((t) => {
        const item = asObj(t);
        return {
          carrier: typeof item?.carrier === 'string' ? item.carrier : null,
          trackingNumber: typeof item?.tracking_number === 'string' ? item.tracking_number : null,
        };
      })
    : [];
  return { id: o.id, status: o.status as HardwareOrderStatus, tracking };
}

export function hardwareOutcome(status: HardwareOrderStatus): { stage: MerchantStage } | { blocked: { code: string; detail: string } } {
  switch (status) {
    case 'pending':
    case 'ready_to_ship':
      return { stage: 'reader_ordered' };
    case 'shipped':
      return { stage: 'reader_shipped' };
    case 'delivered':
      return { stage: 'reader_delivered' };
    case 'canceled':
      return { blocked: { code: 'hardware_order_canceled', detail: 'The card reader order was canceled. Place a new order.' } };
    case 'undeliverable':
      return { blocked: { code: 'hardware_undeliverable', detail: 'The card reader could not be delivered. Confirm the shipping address and reorder.' } };
  }
}
