/**
 * Workforce permission catalog — the STABLE STRINGS that become route guards.
 *
 * These are data, not code branches: the integrator mounts
 * `permissionMiddleware(getUserId, permission)` per route group, and every
 * permission below is a value that `can(...)` unions over a user's roles.
 *
 * NEVER rename or repurpose one of these strings once shipped — a route guard
 * somewhere depends on the exact literal. Add new permissions to the END.
 *
 * Grouping (documented for the README + integrator):
 * - catalog.*      products/variations/price books/promotions
 *     catalog.read   view catalog
 *     catalog.write  create/edit catalog entities, publication state
 * - inventory.*    stock, movements, counts, transfers
 *     inventory.read      view on-hand / movements
 *     inventory.write     adjust / damage / assemble
 *     inventory.count     open & post count sessions
 *     inventory.transfer  move stock between locations
 * - shows.*        venues, show events, manifests, closeout
 *     shows.read   view shows
 *     shows.write  create/edit shows & manifests
 *     shows.close  close a show (financial + inventory finalization)
 * - purchasing.*   vendors (read via purchasing.read), POs, receiving, bills
 *     purchasing.read     view vendors/POs/suggestions
 *     purchasing.write    draft POs / edit reorder policies
 *     purchasing.approve  approve a PO
 * - orders.*       orders, tenders, fulfillment, returns
 *     orders.read    view orders
 *     orders.write   create/edit orders, fulfill, pick/pack
 *     orders.refund  issue a refund / exchange money-back
 * - customers.*    identity, consent, preferences, segments
 *     customers.read    view customer records
 *     customers.write   edit customers / merge
 *     customers.export  export customer PII (guarded separately from read)
 * - outreach.*     campaigns, transactional sends, suppressions
 *     outreach.read     view campaigns/sends
 *     outreach.write    draft campaigns/templates
 *     outreach.approve  approve a campaign for sending
 *     outreach.arm      arm the live send gate (highest outreach privilege)
 * - finance.*      fees, payouts, cash close, COGS, exports
 *     finance.read   view finance + run accountant exports
 *     finance.write  edit finance records / matching
 *     finance.close  run cash close / period close
 * - workforce.*    roles, schedules, this module
 *     workforce.read   view roles/schedules/handoffs
 *     workforce.admin  edit roles/permissions, invite, session policy
 * - admin.*        integrations, credentials, diagnostics, backup/restore
 *     admin.read   view integration/diagnostic state
 *     admin.admin  edit credentials / run backup-restore
 * - actions.*      owner/staff action queue
 *     actions.read   view the action queue
 *     actions.write  resolve/act on queue items
 * - automation.*   deterministic automation rules
 *     automation.read   view rules/history
 *     automation.admin  edit rules / policies / replay
 * - storefront.publish  publish the public catalog/availability projection
 */
export const WORKFORCE_PERMISSIONS = [
  'catalog.read',
  'catalog.write',
  'inventory.read',
  'inventory.write',
  'inventory.count',
  'inventory.transfer',
  'shows.read',
  'shows.write',
  'shows.close',
  'purchasing.read',
  'purchasing.write',
  'purchasing.approve',
  'orders.read',
  'orders.write',
  'orders.refund',
  'customers.read',
  'customers.write',
  'customers.export',
  'outreach.read',
  'outreach.write',
  'outreach.approve',
  'outreach.arm',
  'finance.read',
  'finance.write',
  'finance.close',
  'workforce.read',
  'workforce.admin',
  'admin.read',
  'admin.admin',
  'actions.read',
  'actions.write',
  'automation.read',
  'automation.admin',
  'storefront.publish',
] as const;

export type WorkforcePermission = (typeof WORKFORCE_PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(WORKFORCE_PERMISSIONS);

/** Type guard: is a raw string a known permission? */
export function isWorkforcePermission(value: string): value is WorkforcePermission {
  return PERMISSION_SET.has(value);
}

/** Built-in (non-deletable) role keys. Tenants may add custom roles on top. */
export const BUILTIN_ROLE_KEYS = [
  'owner',
  'manager',
  'cashier',
  'inventory',
  'purchasing',
  'fulfillment',
  'accountant_readonly',
] as const;

export type BuiltinRoleKey = (typeof BUILTIN_ROLE_KEYS)[number];

/** Human-readable default names for the built-in roles. */
export const BUILTIN_ROLE_NAMES: Record<BuiltinRoleKey, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  inventory: 'Inventory',
  purchasing: 'Purchasing',
  fulfillment: 'Fulfillment',
  accountant_readonly: 'Accountant (read-only)',
};

/** All permissions ending in `.read` — the accountant_readonly surface. */
const READ_ONLY_PERMISSIONS = WORKFORCE_PERMISSIONS.filter((p) => p.endsWith('.read'));

/**
 * Least-privilege built-in role → permission matrix.
 *
 * - owner: everything.
 * - manager: broad operational control, but NOT the owner-only privileges
 *   (finance.write/close, outreach.arm, workforce.admin, admin.admin,
 *   automation.admin). Managers approve POs and campaigns and can export
 *   customers, but cannot edit ledgers, arm live sends, rewrite roles, touch
 *   credentials, or edit automation.
 * - cashier: run the register — orders read/write, look up inventory + customers.
 * - inventory: full inventory control + read catalog to find items.
 * - purchasing: vendors/POs/receiving + read catalog & inventory to plan.
 * - fulfillment: fulfill orders, read shows + inventory to pick/pack.
 * - accountant_readonly: every `.read` permission and nothing else — finance
 *   exports run behind finance.read. NO write/approve/close/refund/export/arm/
 *   admin/publish anywhere.
 */
export const BUILTIN_ROLE_PERMISSIONS: Record<BuiltinRoleKey, readonly WorkforcePermission[]> = {
  owner: [...WORKFORCE_PERMISSIONS],
  manager: [
    'catalog.read',
    'catalog.write',
    'inventory.read',
    'inventory.write',
    'inventory.count',
    'inventory.transfer',
    'shows.read',
    'shows.write',
    'shows.close',
    'purchasing.read',
    'purchasing.write',
    'purchasing.approve',
    'orders.read',
    'orders.write',
    'orders.refund',
    'customers.read',
    'customers.write',
    'customers.export',
    'outreach.read',
    'outreach.write',
    'outreach.approve',
    'finance.read',
    'workforce.read',
    'admin.read',
    'actions.read',
    'actions.write',
    'automation.read',
    'storefront.publish',
  ],
  cashier: ['orders.read', 'orders.write', 'inventory.read', 'customers.read'],
  inventory: [
    'inventory.read',
    'inventory.write',
    'inventory.count',
    'inventory.transfer',
    'catalog.read',
  ],
  purchasing: [
    'purchasing.read',
    'purchasing.write',
    'purchasing.approve',
    'catalog.read',
    'inventory.read',
  ],
  fulfillment: ['orders.read', 'orders.write', 'shows.read', 'inventory.read'],
  accountant_readonly: READ_ONLY_PERMISSIONS,
};
