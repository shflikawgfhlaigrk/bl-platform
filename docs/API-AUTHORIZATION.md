# API route authorization

The composition root admits only the method/path templates recorded in apps/api/src/rbac-routes.json. Additions require an explicit inventory change and review of defaultRbacRules in rbac.ts. A missing route or permission disposition returns 403, including for owners. Missing and unknown tenant errors retain the canonical tenant contract.

Read and mutation permissions are distinct. Catalog writes require catalog.write; register product, variation and price lookups accept orders.read as an alternative. Financial and billing writes require finance.write, cash closing requires finance.close, and margin calculation remains a finance.read operation. Inventory count and transfer routes use inventory.count and inventory.transfer; other inventory writes use inventory.write. Purchase approval/rejection uses purchasing.approve. Shows closeout, P&L initialization and closing/closed transitions require shows.close. Employee administration and workforce mutations use workforce.admin, including body-based publication/override and time exports. Action mutations require actions.write; writers may act on their own or unassigned items, while workforce administrators may reassign other users. Assignment targets must belong to the same tenant.

The remaining module pairs are recorded together in defaultRbacRules. Existing finance/admin/outreach and POS money-capture restrictions take precedence. The guard carries the resolved actor to downstream audit records and replaces claimed x-user-id with that actor.

Health and the exact existing POS auth, customer-session, employee-token and public review-token handlers have deliberate independent-auth dispositions. The configured network processor webhook exception remains at composition and verifies signed payloads in its handler. Storefront routes remain outside /api. A public disposition never supplies an owner identity.

Browser identity remains server-session based. The existing trusted local-tool identity lane is unchanged; this permission repair does not establish an authenticated network boundary for arbitrary local headers. Routers/services used outside this composition remain trusted integration APIs and require equivalent authorization from their caller.

Source verification is separate from package, installed runtime, public deployment and real-ledger acceptance. The security regression tests exercise actual cashier POS cookies and supported injected server-verified sessions for non-POS roles, tenant isolation, operation-specific grants, independent portals and all current sibling mutation endpoints.

Raw database backup actions and download additionally require a verified administrator session. A claimed local-tool actor is insufficient. Snapshot creation and delivery are restricted to single-tenant installations; see POS-RUNBOOK.md for artifact, encryption and recovery details.
