# Client Operations local runbook

## Validate

From `/Users/michaelbarber/BlackLabelPlatform`:

```bash
npm --workspace @blacklabel/client-ops test
npm --workspace @blacklabel/client-ops-ui test
npm --workspace @blacklabel/automation test
npm run typecheck
```

## Start the local product

The client-ops server owns a local SQLite database and serves the dependency-free operator UI on loopback only.

```bash
npm --workspace @blacklabel/client-ops-api run start
```

Default URL: `http://127.0.0.1:8470`

Runtime data is stored below `.storage/client-ops`. The demo bootstrap is idempotent: it creates one local tenant, seeds platform roles, installs representative client-ops packages, and supplies runnable evidence data without pretending that external provider adapters are connected.

## Operator proof path

1. Open Overview and confirm all eight service lines are present.
2. Open Services and inspect the eight services, seven vertical packs, two engagement models, readiness, connectors, approvals, artifacts, KPIs, and onboarding.
3. Open Workflows, select a workflow, run it, pause it, then retry the latest run and verify retry lineage.
4. Open Review Inbox and exercise Approve, Deny, and Hold with a decision note.
5. Open Integrations and verify connector state is explicit; missing adapters must not display as connected.
6. Open Artifacts and inspect the receipt and evidence metadata.
7. Open Reports and confirm run, usage, provider cost, and execution totals are tenant-scoped.
8. Open Client Setup and confirm required connector and go-live proof blockers prevent a false-ready state.

## Go-live gate

A client installation is live only when required onboarding steps are complete, required connectors are healthy, workflow validation has passed, operator training is recorded, and a go-live proof receipt exists. A rendered UI or successful local test is not external-system proof.
