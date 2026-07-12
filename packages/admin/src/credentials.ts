import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import { DateTime } from 'luxon';
import type {
  AdminCredentialRow,
  AdminDatabase,
  CredentialProvider,
  CredentialStatus,
} from './schema';
import { decryptJson, encryptJson, maskPayload } from './crypto';

type Db = Kysely<AdminDatabase>;

export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  'smtp',
  'imap',
  'square',
  'stripe',
  'shipping',
  'custom',
];

/** Public (masked) view of a credential — NEVER carries ciphertext or plaintext. */
export interface MaskedCredential {
  id: string;
  name: string;
  provider: CredentialProvider;
  status: CredentialStatus;
  fieldsMasked: Record<string, string>;
  lastTestedAt: string | null;
  expiresAt: string | null;
  rotatedFrom: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Decrypted credential — returned ONLY from get(), which audits every read. */
export interface DecryptedCredential {
  id: string;
  name: string;
  provider: CredentialProvider;
  payload: Record<string, unknown>;
}

export interface SaveCredentialInput {
  name: string;
  provider: CredentialProvider;
  payload: Record<string, unknown>;
  /** ISO-8601 UTC expiry, optional. */
  expiresAt?: string | null;
}

/** A connection tester injected by the integrator (real SMTP NOOP / IMAP login). */
export type CredentialTester = (
  provider: CredentialProvider,
  payload: Record<string, unknown>,
) => Promise<{ ok: boolean; detail?: string }>;

/** Project a row to its masked, safe-to-serialize public shape. */
export function toMasked(row: AdminCredentialRow): MaskedCredential {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    fieldsMasked: JSON.parse(row.fields_masked) as Record<string, string>,
    lastTestedAt: row.last_tested_at,
    expiresAt: row.expires_at,
    rotatedFrom: row.rotated_from,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getRow(
  db: Db,
  tenantId: string,
  credentialId: string,
): Promise<AdminCredentialRow> {
  const row = await db
    .selectFrom('admin_credentials')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', credentialId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`credential "${credentialId}" not found`);
  return row;
}

/**
 * Tenant-scoped credential service. Constructed with the master key (never
 * stored). Encrypts on save, masks for display, audits EVERY decrypt read.
 */
export class CredentialsService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly masterKey: Buffer | string,
  ) {}

  /** Encrypt + mask + insert. Returns the masked view (no secret material). */
  async save(
    tenantId: string,
    actor: string,
    input: SaveCredentialInput,
  ): Promise<MaskedCredential> {
    if (!input.name.trim()) throw ApiError.badRequest('credential name is required');
    if (!CREDENTIAL_PROVIDERS.includes(input.provider)) {
      throw ApiError.badRequest(`unknown provider "${input.provider}"`);
    }
    const now = nowIso();
    const row: AdminCredentialRow = {
      id: id(),
      tenant_id: tenantId,
      name: input.name.trim(),
      provider: input.provider,
      payload_encrypted: encryptJson(input.payload, this.masterKey),
      fields_masked: JSON.stringify(maskPayload(input.payload)),
      status: 'untested',
      last_tested_at: null,
      expires_at: input.expiresAt ?? null,
      rotated_from: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insertInto('admin_credentials').values(row).execute();
    // Audit records the masked shape only — never the plaintext.
    await audit(
      asCoreDb(this.db),
      tenantId,
      actor,
      'admin.credential.saved',
      'admin.credential',
      row.id,
      { provider: row.provider, name: row.name, fields_masked: maskPayload(input.payload) },
    );
    return toMasked(row);
  }

  /** Masked list — never includes ciphertext or plaintext. */
  async list(
    tenantId: string,
    page: Pagination = { limit: 50, offset: 0 },
    opts: { includeArchived?: boolean } = {},
  ): Promise<MaskedCredential[]> {
    let q = this.db
      .selectFrom('admin_credentials')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (!opts.includeArchived) q = q.where('archived_at', 'is', null);
    const rows = await q.orderBy('created_at', 'desc').orderBy('id').limit(page.limit).offset(page.offset).execute();
    return rows.map(toMasked);
  }

  /**
   * DECRYPT a credential for use. Audited on EVERY call with the purpose
   * string — this is the only method that returns plaintext. Callers must
   * pass a non-empty purpose (why the secret is being read).
   */
  async get(
    tenantId: string,
    actor: string,
    credentialId: string,
    purpose: string,
  ): Promise<DecryptedCredential> {
    if (!purpose || !purpose.trim()) {
      throw ApiError.badRequest('a purpose string is required to read a credential');
    }
    const row = await getRow(this.db, tenantId, credentialId);
    const payload = decryptJson<Record<string, unknown>>(row.payload_encrypted, this.masterKey);
    await audit(
      asCoreDb(this.db),
      tenantId,
      actor,
      'admin.credential.read',
      'admin.credential',
      row.id,
      { purpose: purpose.trim() },
    );
    return { id: row.id, name: row.name, provider: row.provider, payload };
  }

  /**
   * Rotate a credential: write a NEW row linked via rotated_from, archive the
   * old one. Business history is preserved (append + archive, never destroy).
   */
  async rotate(
    tenantId: string,
    actor: string,
    credentialId: string,
    newPayload: Record<string, unknown>,
    opts: { expiresAt?: string | null } = {},
  ): Promise<MaskedCredential> {
    const old = await getRow(this.db, tenantId, credentialId);
    if (old.archived_at) throw ApiError.conflict('cannot rotate an archived credential');
    const now = nowIso();
    const fresh: AdminCredentialRow = {
      id: id(),
      tenant_id: tenantId,
      name: old.name,
      provider: old.provider,
      payload_encrypted: encryptJson(newPayload, this.masterKey),
      fields_masked: JSON.stringify(maskPayload(newPayload)),
      status: 'untested',
      last_tested_at: null,
      expires_at: opts.expiresAt ?? null,
      rotated_from: old.id,
      archived_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('admin_credentials').values(fresh).execute();
      await trx
        .updateTable('admin_credentials')
        .set({ archived_at: now, updated_at: now })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', old.id)
        .execute();
    });
    await audit(
      asCoreDb(this.db),
      tenantId,
      actor,
      'admin.credential.rotated',
      'admin.credential',
      fresh.id,
      { rotated_from: old.id },
    );
    return toMasked(fresh);
  }

  /**
   * Delete a credential. Hard delete ONLY for never-used credentials (never
   * tested, still untested, not a rotation source); otherwise archive so the
   * operational history is preserved. Returns the disposition taken.
   */
  async delete(
    tenantId: string,
    actor: string,
    credentialId: string,
  ): Promise<{ disposition: 'deleted' | 'archived' }> {
    const row = await getRow(this.db, tenantId, credentialId);
    const rotatedInto = await this.db
      .selectFrom('admin_credentials')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('rotated_from', '=', credentialId)
      .executeTakeFirst();
    const neverUsed =
      row.last_tested_at === null &&
      row.status === 'untested' &&
      row.archived_at === null &&
      !rotatedInto;

    if (neverUsed) {
      await this.db
        .deleteFrom('admin_credentials')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', credentialId)
        .execute();
      await audit(
        asCoreDb(this.db),
        tenantId,
        actor,
        'admin.credential.deleted',
        'admin.credential',
        credentialId,
        { disposition: 'deleted' },
      );
      return { disposition: 'deleted' };
    }

    await this.db
      .updateTable('admin_credentials')
      .set({ archived_at: nowIso(), updated_at: nowIso() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', credentialId)
      .execute();
    await audit(
      asCoreDb(this.db),
      tenantId,
      actor,
      'admin.credential.archived',
      'admin.credential',
      credentialId,
      { disposition: 'archived' },
    );
    return { disposition: 'archived' };
  }

  /**
   * Test a credential with an INJECTED tester (integrator wires the real SMTP
   * NOOP / IMAP login — founder-clicked, explicit only). Records ok/failed and
   * last_tested_at. The tester result detail must never carry plaintext.
   */
  async testConnection(
    tenantId: string,
    actor: string,
    credentialId: string,
    tester: CredentialTester,
  ): Promise<{ status: CredentialStatus; detail?: string }> {
    const row = await getRow(this.db, tenantId, credentialId);
    const payload = decryptJson<Record<string, unknown>>(row.payload_encrypted, this.masterKey);
    // The decrypt for a test is itself an audited read.
    await audit(
      asCoreDb(this.db),
      tenantId,
      actor,
      'admin.credential.read',
      'admin.credential',
      row.id,
      { purpose: 'testConnection' },
    );

    let ok = false;
    let detail: string | undefined;
    try {
      const res = await tester(row.provider, payload);
      ok = res.ok;
      detail = res.detail;
    } catch (e) {
      ok = false;
      detail = e instanceof Error ? e.message : String(e);
    }
    const status: CredentialStatus = ok ? 'ok' : 'failed';
    const now = nowIso();
    await this.db
      .updateTable('admin_credentials')
      .set({ status, last_tested_at: now, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', credentialId)
      .execute();
    await audit(
      asCoreDb(this.db),
      tenantId,
      actor,
      'admin.credential.tested',
      'admin.credential',
      credentialId,
      { status, detail },
    );
    return { status, detail };
  }

  /**
   * Credentials expiring within `days` of `now` (inclusive), not archived.
   * Pure read — masked results.
   */
  async credentialsExpiringSoon(
    tenantId: string,
    now: string,
    days: number,
  ): Promise<MaskedCredential[]> {
    const cutoff = DateTime.fromISO(now, { zone: 'utc' }).plus({ days }).toUTC().toISO();
    if (!cutoff) throw ApiError.badRequest(`invalid "now" timestamp: ${now}`);
    const rows = await this.db
      .selectFrom('admin_credentials')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('archived_at', 'is', null)
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', cutoff)
      .orderBy('expires_at')
      .orderBy('id')
      .execute();
    return rows.map(toMasked);
  }

  /**
   * Emit `admin.credential.expiring` for each soon-to-expire credential so the
   * actions module can raise a credential_expiring action. Integrator schedules
   * this (e.g. a daily health tick). Returns the credentials it flagged.
   */
  async watchExpiringCredentials(
    tenantId: string,
    now: string,
    days: number,
  ): Promise<MaskedCredential[]> {
    const soon = await this.credentialsExpiringSoon(tenantId, now, days);
    for (const cred of soon) {
      await this.events.emit(tenantId, 'admin.credential.expiring', {
        v: 1,
        credentialId: cred.id,
        provider: cred.provider,
        expiresAt: cred.expiresAt,
      });
    }
    return soon;
  }
}
