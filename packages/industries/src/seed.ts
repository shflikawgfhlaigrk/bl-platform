import type { Kysely } from 'kysely';
import type { EventBus } from '@blacklabel/core';
import { listIndustries } from './registry';
import type { IndustriesDatabase } from './schema';
import { applyIndustry, type AppliedIndustry } from './service';

/**
 * Demo/seed helper: apply an industry's defaults to a tenant. When no
 * industryKey is given, the first available industry (alphabetical) is used —
 * nothing industry-specific is hardcoded.
 */
export async function seedIndustries(
  db: Kysely<IndustriesDatabase>,
  tenantId: string,
  industryKey?: string,
  events?: EventBus,
): Promise<AppliedIndustry> {
  const key = industryKey ?? listIndustries()[0]!.key;
  return applyIndustry(db, tenantId, key, { events, actor: 'system' });
}
