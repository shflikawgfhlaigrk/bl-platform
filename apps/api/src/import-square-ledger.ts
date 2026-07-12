/**
 * Import a Square-shaped sales ledger (SQLite) into a platform tenant:
 *   - customers → crm (created once, linked via retail_customer_links)
 *   - payments / order lines (with denormalized category) / refunds → retail
 *
 * The importer is idempotent end to end: re-running against the same ledger
 * inserts nothing new. Every gate below prints its computed value and the
 * run FAILS (non-zero exit) if any gate does not hold.
 *
 * Run from the repo root:
 *   PLATFORM_STORAGE_DIR=... PLATFORM_DB_PATH=... \
 *   npm --workspace @blacklabel/api run import-square -- \
 *     --ledger ~/MagsTack/ledger.db --tenant "Mags Tack" --industry tack-retail
 *
 * This script only READS the ledger file (mode=ro) and only WRITES the
 * platform tenant database. It never touches a network.
 */
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Kysely } from 'kysely';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createDb } from '@blacklabel/db';
import {
  getCustomerLink,
  importSales,
  linkCustomer,
  type ImportOrderLineInput,
  type ImportPaymentInput,
  type ImportRefundInput,
  type RetailDatabase,
} from '@blacklabel/retail';
import { createApp, type PlatformDatabase } from './app';

/** Narrow the one shared db to a module's view (same pattern as app.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dbAs<T>(d: Kysely<any>): Kysely<T> {
  return d as Kysely<T>;
}

/* ---------------------------------------------------------------- args */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const LEDGER_PATH = arg('ledger');
const TENANT_NAME = arg('tenant');
const INDUSTRY_KEY = arg('industry');

if (!LEDGER_PATH || !TENANT_NAME) {
  console.error('usage: import-square --ledger <ledger.db> --tenant <name> [--industry <key>]');
  process.exit(2);
}

const STORAGE_DIR = path.resolve(process.env.PLATFORM_STORAGE_DIR ?? '.storage');
const DB_PATH = process.env.PLATFORM_DB_PATH ?? path.join(STORAGE_DIR, 'platform.db');
mkdirSync(STORAGE_DIR, { recursive: true });

/* ---------------------------------------------------------------- gates */

let failures = 0;
function gate(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'GATE PASS' : 'GATE FAIL'}  ${name}  ${detail}`);
  if (!ok) failures += 1;
}

/* ---------------------------------------------------------------- main */

const ledger = new Database(LEDGER_PATH, { readonly: true, fileMustExist: true });
const db = createDb<PlatformDatabase>(DB_PATH);
const platform = await createApp({ db });

// Tenant: find by exact name or create.
const existingTenant = await asCoreDb(db)
  .selectFrom('tenants')
  .selectAll()
  .where('name', '=', TENANT_NAME)
  .orderBy('created_at')
  .orderBy('id')
  .executeTakeFirst();
const tenant = existingTenant ?? (await createTenant(asCoreDb(db), { name: TENANT_NAME }));
console.log(`tenant "${tenant.name}" id=${tenant.id}${existingTenant ? ' (existing)' : ' (created)'}`);

// Industry config (idempotent through the router).
if (INDUSTRY_KEY) {
  const res = await platform.app.request(`/api/industries/${INDUSTRY_KEY}/apply`, {
    method: 'POST',
    headers: { 'x-tenant-id': tenant.id, 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'import-square' }),
  });
  console.log(`industry apply ${INDUSTRY_KEY}: HTTP ${res.status}`);
  if (res.status >= 400) {
    console.error(await res.text());
    process.exit(1);
  }
}

/* ---- customers → crm (+ links) ---- */

interface LedgerCustomer {
  id: string;
  given_name: string | null;
  family_name: string | null;
  email: string | null;
  phone: string | null;
}

const ledgerCustomers = ledger
  .prepare('SELECT id, given_name, family_name, email, phone FROM customers ORDER BY id')
  .all() as LedgerCustomer[];

const blankToNull = (v: string | null): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

let customersCreated = 0;
let customersExisting = 0;
let processed = 0;
for (const c of ledgerCustomers) {
  processed += 1;
  const link = await getCustomerLink(dbAs<RetailDatabase>(db), tenant.id, c.id);
  if (link) {
    customersExisting += 1;
    continue;
  }
  const name =
    [blankToNull(c.given_name), blankToNull(c.family_name)].filter(Boolean).join(' ') ||
    blankToNull(c.email) ||
    '(no name on file)';
  // Through the crm ROUTER — its public, validated write path.
  const res = await platform.app.request('/api/crm/customers', {
    method: 'POST',
    headers: {
      'x-tenant-id': tenant.id,
      'x-user-id': 'import-square',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name,
      email: blankToNull(c.email),
      phone: blankToNull(c.phone),
    }),
  });
  if (res.status !== 201) {
    console.error(`\ncustomer create failed (${res.status}) for ledger id ${c.id}: ${await res.text()}`);
    process.exit(1);
  }
  const created = ((await res.json()) as { data: { id: string } }).data;
  await linkCustomer(dbAs<RetailDatabase>(db), tenant.id, c.id, created.id);
  customersCreated += 1;
  if (processed % 500 === 0 || processed === ledgerCustomers.length) {
    process.stdout.write(`\rcustomers: ${processed}/${ledgerCustomers.length}`);
  }
}
console.log('');

/* ---- payments / lines / refunds → retail ---- */

interface LedgerPayment {
  id: string;
  created_at: string | null;
  status: string | null;
  amount_cents: number | null;
  processing_fee_cents: number | null;
  customer_id: string | null;
  order_id: string | null;
}
const ledgerPayments = ledger
  .prepare(
    'SELECT id, created_at, status, amount_cents, processing_fee_cents, customer_id, order_id FROM payments ORDER BY id',
  )
  .all() as LedgerPayment[];

let paymentsUnusable = 0;
const payments: ImportPaymentInput[] = [];
for (const p of ledgerPayments) {
  if (!p.created_at || !p.status || p.amount_cents === null) {
    paymentsUnusable += 1;
    continue;
  }
  payments.push({
    sourceId: p.id,
    paidAt: p.created_at,
    status: p.status,
    amountCents: p.amount_cents,
    feeCents: p.processing_fee_cents,
    customerSourceId: p.customer_id,
    orderSourceId: p.order_id,
  });
}

// Variation id → category name (denormalized onto each line at import time).
const categoryByVariation = new Map<string, string>();
for (const row of ledger
  .prepare(
    `SELECT iv.id AS vid, ci.category_name AS cat
     FROM item_variations iv JOIN catalog_items ci ON ci.id = iv.item_id
     WHERE ci.category_name IS NOT NULL`,
  )
  .all() as { vid: string; cat: string }[]) {
  categoryByVariation.set(row.vid, row.cat);
}

interface LedgerLine {
  order_id: string | null;
  name: string | null;
  quantity: string | null;
  catalog_object_id: string | null;
  total_cents: number | null;
}
const ledgerLines = ledger
  .prepare('SELECT order_id, name, quantity, catalog_object_id, total_cents FROM order_line_items')
  .all() as LedgerLine[];

let linesUnusable = 0;
const orderLines: ImportOrderLineInput[] = [];
for (const l of ledgerLines) {
  if (!l.order_id) {
    linesUnusable += 1;
    continue;
  }
  const qty = Number.parseFloat(l.quantity ?? '');
  orderLines.push({
    sourceOrderId: l.order_id,
    name: l.name ?? '(unnamed item)',
    quantity: Number.isFinite(qty) ? qty : 0,
    totalCents: l.total_cents ?? 0,
    catalogSourceId: l.catalog_object_id,
    categoryName: l.catalog_object_id
      ? (categoryByVariation.get(l.catalog_object_id) ?? null)
      : null,
  });
}

interface LedgerRefund {
  id: string;
  created_at: string | null;
  status: string | null;
  amount_cents: number | null;
}
const ledgerRefunds = ledger
  .prepare('SELECT id, created_at, status, amount_cents FROM refunds ORDER BY id')
  .all() as LedgerRefund[];
let refundsUnusable = 0;
const refunds: ImportRefundInput[] = [];
for (const r of ledgerRefunds) {
  if (!r.created_at || !r.status || r.amount_cents === null) {
    refundsUnusable += 1;
    continue;
  }
  refunds.push({
    sourceId: r.id,
    refundedAt: r.created_at,
    status: r.status,
    amountCents: r.amount_cents,
  });
}

console.log(
  `parsed: ${payments.length} payments (${paymentsUnusable} unusable), ` +
    `${orderLines.length} lines (${linesUnusable} unusable), ` +
    `${refunds.length} refunds (${refundsUnusable} unusable)`,
);

const result = await importSales(dbAs<RetailDatabase>(db), platform.events, tenant.id, 'import-square', {
  source: `square-ledger:${path.basename(LEDGER_PATH)}`,
  payments,
  orderLines,
  refunds,
});
console.log('import run:', JSON.stringify(result));

/* ---------------------------------------------------------------- verify */

const ledgerGross = (
  ledger
    .prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS g, COUNT(*) AS n FROM payments WHERE status = 'COMPLETED'",
    )
    .get() as { g: number; n: number }
);

gate(
  'completed-gross-to-the-cent',
  result.completedGrossCentsAfter === ledgerGross.g,
  `tenant=${result.completedGrossCentsAfter} ledger=${ledgerGross.g}`,
);

const tenantCounts = await db
  .selectFrom('retail_payments')
  .select((eb) => eb.fn.countAll<number>().as('n'))
  .where('tenant_id', '=', tenant.id)
  .executeTakeFirst();
gate(
  'payment-row-count',
  Number(tenantCounts?.n ?? 0) === payments.length,
  `tenant=${tenantCounts?.n} ledger-usable=${payments.length} (raw ${ledgerPayments.length})`,
);

const tenantLines = await db
  .selectFrom('retail_order_lines')
  .select((eb) => eb.fn.countAll<number>().as('n'))
  .where('tenant_id', '=', tenant.id)
  .executeTakeFirst();
gate(
  'line-row-count',
  Number(tenantLines?.n ?? 0) === orderLines.length,
  `tenant=${tenantLines?.n} ledger-usable=${orderLines.length} (raw ${ledgerLines.length})`,
);

const tenantRefunds = await db
  .selectFrom('retail_refunds')
  .select((eb) => eb.fn.countAll<number>().as('n'))
  .where('tenant_id', '=', tenant.id)
  .executeTakeFirst();
gate(
  'refund-row-count',
  Number(tenantRefunds?.n ?? 0) === refunds.length,
  `tenant=${tenantRefunds?.n} ledger-usable=${refunds.length}`,
);

const tenantCustomers = await db
  .selectFrom('crm_customers')
  .select((eb) => eb.fn.countAll<number>().as('n'))
  .where('tenant_id', '=', tenant.id)
  .executeTakeFirst();
gate(
  'customer-count',
  Number(tenantCustomers?.n ?? 0) === ledgerCustomers.length,
  `tenant=${tenantCustomers?.n} ledger=${ledgerCustomers.length} (created ${customersCreated}, already-linked ${customersExisting})`,
);

const tenantEmails = await db
  .selectFrom('crm_customers')
  .select((eb) => eb.fn.countAll<number>().as('n'))
  .where('tenant_id', '=', tenant.id)
  .where('email', 'is not', null)
  .executeTakeFirst();
const ledgerEmails = (
  ledger
    .prepare("SELECT COUNT(*) AS n FROM customers WHERE email IS NOT NULL AND TRIM(email) != ''")
    .get() as { n: number }
);
gate(
  'customer-email-count',
  Number(tenantEmails?.n ?? 0) === ledgerEmails.n,
  `tenant=${tenantEmails?.n} ledger=${ledgerEmails.n}`,
);

// Yearly rollups (UTC calendar year, same bucketing both sides) to the cent.
const ledgerYears = ledger
  .prepare(
    `SELECT SUBSTR(created_at, 1, 4) AS y, SUM(amount_cents) AS g
     FROM payments WHERE status = 'COMPLETED' GROUP BY y ORDER BY y`,
  )
  .all() as { y: string; g: number }[];
for (const row of ledgerYears) {
  const tenantYear = await db
    .selectFrom('retail_payments')
    .select((eb) => eb.fn.sum<number>('amount_cents').as('g'))
    .where('tenant_id', '=', tenant.id)
    .where('status', '=', 'COMPLETED')
    .where('paid_at', '>=', `${row.y}-01-01`)
    .where('paid_at', '<', `${Number(row.y) + 1}-01-01`)
    .executeTakeFirst();
  gate(
    `yearly-gross-${row.y}`,
    Number(tenantYear?.g ?? 0) === row.g,
    `tenant=${tenantYear?.g} ledger=${row.g}`,
  );
}

ledger.close();
platform.detachEngine();
await db.destroy();

if (failures > 0) {
  console.error(`\n${failures} GATE(S) FAILED — the import is NOT verified.`);
  process.exit(1);
}
console.log('\nALL GATES PASSED — import verified against the ledger.');
