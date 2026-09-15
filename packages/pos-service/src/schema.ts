import type { CoreDatabase } from '@blacklabel/core';

/**
 * One row per merchant sold the done-for-you POS service. The full lifecycle record is JSON in
 * `record`; the columns beside it exist for tenant-scoped lookups, uniqueness, and optimistic
 * concurrency (`version`).
 */
export interface PosServiceMerchantRow {
  id: string;
  tenant_id: string;
  version: number;
  /** 0/1: the Stripe mode the merchant was created in. */
  livemode: number;
  purchase_ref: string;
  stripe_account_id: string | null;
  stage: string;
  blocked_code: string | null;
  record: string;
  created_at: string;
  updated_at: string;
}

/** Stripe webhook event ids already processed, so a redelivery is not applied twice. */
export interface PosServiceWebhookEventRow {
  id: string;
  tenant_id: string;
  event_id: string;
  created_at: string;
}

export interface PosServiceDatabase extends CoreDatabase {
  pos_service_merchants: PosServiceMerchantRow;
  pos_service_webhook_events: PosServiceWebhookEventRow;
}
