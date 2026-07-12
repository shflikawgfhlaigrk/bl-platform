import type { Kysely } from 'kysely';
import { asCoreDb, audit, id, nowIso } from '@blacklabel/core';
import { z } from 'zod';
import type { AdminDatabase, AdminSettingsRow } from './schema';

type Db = Kysely<AdminDatabase>;

/**
 * Business identity + operational defaults — the single source other modules
 * receive via the integrator (postal address for CAN-SPAM footers, timezone
 * for business-day grouping, quiet-hours defaults for outreach).
 */
export const postalAddressSchema = z.object({
  line1: z.string().trim().min(1),
  line2: z.string().trim().optional(),
  city: z.string().trim().min(1),
  region: z.string().trim().min(1),
  postalCode: z.string().trim().min(1),
  country: z.string().trim().min(1),
});

export const quietHoursSchema = z.object({
  /** Local "HH:mm" 24h. */
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export const settingsSchema = z.object({
  name: z.string().trim().min(1),
  postalAddress: postalAddressSchema,
  /** IANA timezone, e.g. "America/New_York". */
  timezone: z.string().trim().min(1),
  quietHours: quietHoursSchema.optional(),
});

export type AdminSettings = z.infer<typeof settingsSchema>;

export function parseSettingsRow(row: AdminSettingsRow): AdminSettings {
  return settingsSchema.parse(JSON.parse(row.data));
}

export class SettingsService {
  constructor(private readonly db: Db) {}

  /** The tenant's settings, or null if never configured (setup state). */
  async get(tenantId: string): Promise<AdminSettings | null> {
    const row = await this.db
      .selectFrom('admin_settings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    return row ? (JSON.parse(row.data) as AdminSettings) : null;
  }

  /**
   * Validate + upsert the singleton settings row (check-then-insert/update, no
   * ON CONFLICT). Audited. Returns the validated settings.
   */
  async update(
    tenantId: string,
    actor: string,
    input: unknown,
  ): Promise<AdminSettings> {
    const parsed = settingsSchema.parse(input);
    const data = JSON.stringify(parsed);
    const now = nowIso();
    const existing = await this.db
      .selectFrom('admin_settings')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    if (existing) {
      await this.db
        .updateTable('admin_settings')
        .set({ data, updated_at: now })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', existing.id)
        .execute();
    } else {
      const row: AdminSettingsRow = {
        id: id(),
        tenant_id: tenantId,
        data,
        created_at: now,
        updated_at: now,
      };
      await this.db.insertInto('admin_settings').values(row).execute();
    }
    await audit(
      asCoreDb(this.db),
      tenantId,
      actor,
      'admin.settings.updated',
      'admin.settings',
      tenantId,
      { name: parsed.name, timezone: parsed.timezone },
    );
    return parsed;
  }
}
