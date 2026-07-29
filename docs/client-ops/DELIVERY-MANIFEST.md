# Black Label Client Operations delivery manifest

Delivery date: 2026-07-15

Catalog version: `2026-07-15`

## Included sellable services

1. Workflow Operating System
2. AI Front Desk
3. Sales Operator
4. Marketing Operator
5. Support Operator
6. Executive Operations HQ
7. Private Company Agent
8. Data Operations Service

## Included vertical packs

1. Medical and dental receptionist
2. Real-estate acquisition desk
3. Home-services lead and scheduling operator
4. Law-firm intake and document routing
5. Property-management maintenance desk
6. E-commerce support and marketing operator
7. Local-business review and reactivation system

## Included engagement models

- Workflow Automation Sprint
- Managed AI Operations

## Source bundle contents

- `apps/client-ops-api`: loopback API, local SQLite runtime, empty production onboarding, explicit opt-in demo seed, and static UI server
- `apps/client-ops-ui`: dependency-free operator application with responsive black-and-gold interface
- `packages/client-ops`: catalog, 30-entry portfolio registry, manifests, signing, tenancy, installations, workflows, adapters, connectors, onboarding, runs, reviews, product test/package evidence, receipts, usage, and reporting
- `packages/automation`: shared approval engine with Approve, Deny, and Hold state transitions
- `packages/core` and `packages/db`: required local workspace foundations
- `docs/client-ops`: product, architecture, design-system, runbook, and concept documentation
- root npm, TypeScript, and Vitest configuration required to install, test, and run the bundle

Runtime databases, dependency folders, build caches, credentials, and unrelated repository changes are excluded.

## Start and verify

Requires Node.js 22 or newer.

```bash
npm install
npm run typecheck
npm test
npm --workspace @blacklabel/client-ops-api run start
```

Open `http://127.0.0.1:8470`.

## Product truth

The reusable product engine, operator interface, package catalog, workflow controls, approvals, evidence, receipts, cost reporting, onboarding, and adapter contracts are included. Workflow Operating System has a local foundation adapter. Provider-dependent services remain explicitly marked as requiring setup until real client telephony, CRM, calendar, publishing, helpdesk, private-agent, and data-provider credentials are connected and verified.

## Visual contract

All application surfaces are black or near-black. Typography, controls, borders, progress, healthy states, and brand accents are gold. White or light surfaces, green, and lime are prohibited.

## Verification recorded before delivery

- 1,377 repository tests passed
- TypeScript project typecheck passed
- Desktop and mobile browser verification passed
- No mobile horizontal overflow
- No browser console warnings or errors
- Live Hold and failed-run Retry workflows verified
- Live palette scan found no green colors and no white or light content surfaces
