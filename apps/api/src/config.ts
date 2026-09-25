/**
 * Composition-root configuration: env contract + per-tenant operational config
 * (inventory location ids, seeded owner) + the deterministic event-dedupe
 * helper the cross-module wiring uses to stay replay-safe.
 *
 * Nothing here talks to the network. Env is read ONCE, in `readEnvConfig`,
 * which server.ts calls; `createApp` receives already-resolved options so the
 * in-memory boot test never touches the environment or the filesystem.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { id, nowIso } from '@blacklabel/core';
import type { ApiDatabase } from './migrations';

/** Well-known api_config keys. */
export const CONFIG_KEYS = {
  defaultLocation: 'default_location_id',
  quarantineLocation: 'quarantine_location_id',
  damagedLocation: 'damaged_location_id',
  ownerUserId: 'owner_user_id',
  /** Explicit tenant POS tax rate. Missing is different from a configured 0%. */
  posTaxBps: 'pos_tax_bps',
  /** Optional text printed below POS receipts. */
  posReceiptFooter: 'pos_receipt_footer',
  /** Prefix + manifestId → the inventory transfer created for a show load-out. */
  manifestTransferPrefix: 'manifest_transfer:',
} as const;

type Db = Kysely<ApiDatabase>;

/** Read a single api_config value (tenant-scoped). */
export async function getConfig(db: Db, tenantId: string, key: string): Promise<string | null> {
  const row = await db
    .selectFrom('api_config')
    .select('value')
    .where('tenant_id', '=', tenantId)
    .where('key', '=', key)
    .executeTakeFirst();
  return row?.value ?? null;
}

/** Idempotent upsert of an api_config value (check-then-insert; no ON CONFLICT). */
export async function setConfig(db: Db, tenantId: string, key: string, value: string): Promise<void> {
  const now = nowIso();
  const existing = await db
    .selectFrom('api_config')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('key', '=', key)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('api_config')
      .set({ value, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', existing.id)
      .execute();
    return;
  }
  await db
    .insertInto('api_config')
    .values({ id: id(), tenant_id: tenantId, key, value, created_at: now, updated_at: now })
    .execute();
}

/**
 * Resolve the tenant's default inventory location id. Order:
 *   1. api_config `default_location_id` (owner-configured, per tenant)
 *   2. the process-wide env fallback `DEFAULT_LOCATION_ID` (single-tenant dev)
 * Returns null when unresolvable — callers open a `setup_required` action rather
 * than guessing a location (never fabricate stock topology).
 */
export async function resolveDefaultLocationId(
  db: Db,
  tenantId: string,
  envFallback?: string,
): Promise<string | null> {
  const configured = await getConfig(db, tenantId, CONFIG_KEYS.defaultLocation);
  if (configured) return configured;
  return envFallback && envFallback.trim() !== '' ? envFallback.trim() : null;
}

/**
 * Check-then-insert a dedupe key. Returns true when THIS call claimed the key
 * (first time — the caller should perform the effect), false when it was already
 * claimed (a replay/duplicate — the caller must skip). A UNIQUE index backs the
 * key so a concurrent double-claim fails the second insert; we treat that as
 * "already claimed" too.
 */
export async function claimOnce(db: Db, tenantId: string, dedupeKey: string): Promise<boolean> {
  const existing = await db
    .selectFrom('api_event_dedupe')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('dedupe_key', '=', dedupeKey)
    .executeTakeFirst();
  if (existing) return false;
  try {
    await db
      .insertInto('api_event_dedupe')
      .values({ id: id(), tenant_id: tenantId, dedupe_key: dedupeKey, created_at: nowIso() })
      .execute();
    return true;
  } catch {
    // Lost the race on the UNIQUE index — someone else claimed it.
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Master key + derived secrets
 * ------------------------------------------------------------------ */

/** A stable 32-byte key as a Buffer, from a base64/hex/utf8 source or generated. */
export function coerceKey(source: Buffer | string | undefined): Buffer {
  if (source instanceof Buffer) return source;
  if (typeof source === 'string' && source.length > 0) {
    for (const enc of ['base64', 'hex'] as const) {
      try {
        const b = Buffer.from(source, enc);
        if (b.length === 32) return b;
      } catch {
        /* try next */
      }
    }
    // Fall back to a deterministic 32-byte digest of the passphrase.
    return createHash('sha256').update(source, 'utf8').digest();
  }
  // No key configured — ephemeral (fine for tests / import runs; credentials
  // saved under it will not decrypt across a restart, which server.ts avoids by
  // persisting a real key).
  return randomBytes(32);
}

/** Deterministic checkout-simulator HMAC secret derived from the master key. */
export function deriveCheckoutSecret(masterKey: Buffer, explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit.trim();
  return createHash('sha256').update(masterKey).update('checkout-sim').digest('hex');
}

/* ------------------------------------------------------------------ *
 * Env contract (server.ts only)
 * ------------------------------------------------------------------ */

export interface EnvConfig {
  port: number;
  storageDir: string;
  dbPath: string;
  uiDir: string | undefined;
  defaultTenantName: string | undefined;
  defaultLocationId: string | undefined;
  ownerUserId: string | undefined;
  checkoutSimSecret: string | undefined;
  unsubscribeBaseUrl: string;
  masterKeySource: Buffer | string | undefined;
}
