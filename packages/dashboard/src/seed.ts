import type { Kysely } from 'kysely';
import { id, nowIso } from '@blacklabel/core';
import type { DashboardDatabase } from './schema';
import { WIDGET_CATALOG } from './service';

/**
 * Demo data for the dashboard module: a saved widget configuration (all
 * catalog widgets, default order) and two example alert rules.
 *
 * NOTE: seeds ONLY dashboard-owned tables. The aggregation sources belong
 * to other modules and are seeded by their own seed helpers.
 */
export async function seedDashboard(
  db: Kysely<DashboardDatabase>,
  tenantId: string,
): Promise<void> {
  const now = nowIso();

  await db
    .insertInto('dashboard_widget_configs')
    .values(
      WIDGET_CATALOG.map((def, index) => ({
        id: id(),
        tenant_id: tenantId,
        widget_key: def.key,
        position: index,
        enabled: 1,
        settings: '{}',
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();

  await db
    .insertInto('dashboard_alert_rules')
    .values([
      {
        id: id(),
        tenant_id: tenantId,
        name: 'Open tasks piling up',
        metric: 'open_tasks',
        threshold: 25,
        direction: 'above',
        enabled: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: id(),
        tenant_id: tenantId,
        name: 'Quote conversion below 20%',
        metric: 'quote_conversion_bps',
        threshold: 2000,
        direction: 'below',
        enabled: 1,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();
}
