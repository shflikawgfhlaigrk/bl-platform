import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
// Reviewed business-module journeys and their affected controls. Commerce/POS,
// native products, customer storage and the full repository battery are excluded.
const files = [
 'packages/crm/test/sales-queue.test.ts','packages/crm/test/leads.test.ts','packages/crm/test/customers.test.ts','packages/crm/test/hardening.test.ts',
 'packages/scheduling/test/availability-guards.test.ts','packages/scheduling/test/contract-receipts.test.ts','packages/scheduling/test/service.test.ts','packages/scheduling/test/router.test.ts','packages/scheduling/test/next-available.test.ts','packages/scheduling/test/google-calendar.test.ts',
 'packages/quoting/test/integrity.test.ts','packages/quoting/test/approval.test.ts','packages/quoting/test/pricing.test.ts','packages/quoting/test/router.test.ts','packages/quoting/test/tenancy.test.ts','packages/quoting/test/migrations.test.ts',
 'packages/portal-customer/test/requests.test.ts','packages/portal-customer/test/portal.test.ts','packages/portal-customer/test/ui.test.ts',
 'packages/portal-employee/test/closeout.test.ts','packages/portal-employee/test/assignments.test.ts','packages/portal-employee/test/auth.test.ts','packages/portal-employee/test/checklists.test.ts',
 'packages/dashboard/test/exceptions.test.ts','packages/dashboard/test/exceptions-ui.test.ts','packages/dashboard/test/router.test.ts',
 'packages/messaging/test/inbound-ownership.test.ts','packages/messaging/test/business-ui.test.ts','packages/messaging/test/durable-delivery.test.ts','packages/messaging/test/service.test.ts','packages/messaging/test/router.test.ts',
 'packages/reviews/test/eligibility-recovery.test.ts','packages/reviews/test/public-gating.test.ts','packages/reviews/test/public-ui.test.ts','packages/reviews/test/router.test.ts','packages/reviews/test/tenant-isolation.test.ts','packages/reviews/test/migrations.test.ts',
 'packages/workflows/test/recovery-receipts.test.ts','packages/workflows/test/engine.test.ts','packages/workflows/test/retry.test.ts','packages/workflows/test/isolation.test.ts','packages/workflows/test/router.test.ts',
 'packages/billing/test/collections.test.ts','packages/billing/test/invoices.test.ts','packages/billing/test/providers.test.ts','packages/billing/test/subscriptions.test.ts',
 'packages/files/test/evidence.test.ts','packages/files/test/router.test.ts','packages/files/test/permissions.test.ts','packages/files/test/upload-limits.test.ts',
 'packages/industries/test/router.test.ts','packages/industries/test/service.test.ts',
 'apps/api/test/business-industry-wiring.test.ts','apps/api/test/business-conversion.test.ts','apps/api/test/business-portal-requests.test.ts','apps/api/test/business-reviews.test.ts','apps/api/test/business-reminders.test.ts',
 'apps/api/test/rbac-coverage.test.ts','apps/api/test/body-limit.test.ts','apps/api/test/rate-limit-capacity.test.ts','apps/api/test/security.test.ts',
 'apps/business/test/integrations.test.ts','apps/business/test/billing-boundary.test.ts','apps/business/test/employee-ui.test.ts','apps/business/test/access.test.ts','apps/business/test/team.test.ts','apps/business/test/transport.test.ts','apps/business/test/photo-file-isolation.test.ts',
];
for (const file of files) if (!existsSync(file)) throw Error(`Focused candidate check missing: ${file}`);
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,'--maxWorkers=1'],{stdio:'inherit'});
process.exit(result.status??1);
