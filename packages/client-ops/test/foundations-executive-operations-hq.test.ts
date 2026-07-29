import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceFoundationRegistry } from '../src/adapters';
import { ExecutiveOperationsHqAdapter } from '../src/foundations/executive-operations-hq';
import { executeRun } from '../src/runner';
import { ClientOpsService } from '../src/service';
import { createActiveInstallation, createInstallation, createRun, headers, setup } from './helpers';

/**
 * Runtime proof for the Executive Operations HQ execution adapter
 * (service `executive-operations-hq`, capability `client_ops.hq.publish_brief`,
 * owned source `BlackLabelHQ`). Mirrors runner.test.ts but drives an
 * `executive-operations-hq` installation.
 *
 * The adapter reads REAL computed-% handoff packets off disk. Each test seeds a
 * temp directory with a genuine packet (same schema as
 * `~/BlackLabel-Team/STATE/handoffs/*.json`) and points the adapter at it, so the
 * assertions exercise the real read→assemble→deep-link path deterministically —
 * not a hardcoded string. Pointed at its default dir the same code reads the
 * live fleet packets.
 */

const FIXTURE_SEAT = 'executive-operations-fixture';
const FIXTURE_PERCENT = 67;

const tmpDirs: string[] = [];

/** Write one or more real handoff packets into a fresh temp dir; return its path. */
function seedHandoffDir(packets: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hq-handoffs-'));
  tmpDirs.push(dir);
  packets.forEach((packet, index) => {
    writeFileSync(join(dir, `${String(index).padStart(2, '0')}-packet.json`), JSON.stringify(packet, null, 2));
  });
  return dir;
}

function fixturePacket(): Record<string, unknown> {
  return {
    seat: FIXTURE_SEAT,
    task: 'adapter-runtime-verification',
    ts: '2026-07-23T18:00:00Z',
    checklist: [
      { item: 'read newest handoff packets from disk', done: true, status: 'pass', evidence: 'parsed real JSON' },
      { item: 'assemble module-scoped operations brief', done: true, status: 'pass' },
      { item: 'deep-link every statement to owned evidence', done: false, status: 'open' },
    ],
    percent: FIXTURE_PERCENT,
    blockers: ['one verification item still open'],
    next: 'wire brief into the executive dashboard',
    client_work: false,
  };
}

/**
 * Activate an installation for a specific catalog offering, WITH this tenant's own
 * instance of the service's owned source connected. Execution is gated per tenant
 * now — a tenant that has connected nothing of its own resolves to
 * awaiting-connection instead of reaching Black Label's sources — so a test that
 * wants a real run must model a properly connected client.
 */
async function createActiveInstallationFor(
  app: Awaited<ReturnType<typeof setup>>['app'],
  tenant: { id: string },
  catalogId: string,
  options: { declareOwnedSource?: boolean } = {},
) {
  return createActiveInstallation(app, tenant, {
    catalogId,
    declareOwnedSource: options.declareOwnedSource ?? true,
  });
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('executive-operations-hq foundation adapter', () => {
  it('drives a requested executive-operations-hq run to success and writes a real, persisted completion receipt', async () => {
    const { db, events, app, tenantA } = await setup();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallationFor(app, tenantA, 'executive-operations-hq');
    expect(installation.catalogId).toBe('executive-operations-hq');
    const run = await createRun(app, tenantA, installation);
    expect(run.status).toBe('requested');

    const handoffsDir = seedHandoffDir([fixturePacket()]);
    const adapter = new ExecutiveOperationsHqAdapter({ handoffsDir });
    expect(adapter.readiness()).toBe('ready');

    const registry = new ServiceFoundationRegistry();
    registry.register(adapter);

    const outcome = await executeRun(
      { service, registry },
      { tenantId: tenantA.id, runId: run.id, approved: true },
    );

    expect(outcome.status).toBe('succeeded');

    // State change is real and persisted, not a returned literal.
    const persisted = await service.getRun(tenantA.id, run.id);
    expect(persisted.status).toBe('succeeded');

    if (outcome.status === 'succeeded') {
      const receipt = await service.getCompletionReceipt(tenantA.id, outcome.receiptId);
      expect(receipt.runId).toBe(run.id);
      expect(receipt.summary).toContain('client_ops.hq.publish_brief');
      // Evidence deep-links to the module-owned handoff packet that backed the brief.
      expect(JSON.stringify(receipt.verification)).toContain('client-ops://hq/handoffs/');

      // Output is assembled from the seeded packet on disk — prove it is not hardcoded.
      const serializedResults = JSON.stringify(outcome.results);
      expect(serializedResults).toContain(FIXTURE_SEAT);
      expect(serializedResults).toContain(String(FIXTURE_PERCENT));
    }
  });

  it('fails honestly with no receipt when no adapter is connected — never fabricates success', async () => {
    const { db, events, app, tenantA } = await setup();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallationFor(app, tenantA, 'executive-operations-hq');
    const run = await createRun(app, tenantA, installation);

    const outcome = await executeRun(
      { service, registry: new ServiceFoundationRegistry() },
      { tenantId: tenantA.id, runId: run.id, approved: true },
    );

    expect(outcome.status).toBe('failed');
    const persisted = await service.getRun(tenantA.id, run.id);
    expect(persisted.status).toBe('failed');
    await expect(service.listCompletionReceipts(tenantA.id, { limit: 10, offset: 0 })).resolves.toHaveLength(0);
  });

  it('assembles a real brief from packets on disk via direct invoke, and stays honest (declared + failed) when the source is empty', async () => {
    // Ready path: a genuine packet directory yields a brief with derived aggregates.
    const handoffsDir = seedHandoffDir([
      fixturePacket(),
      { seat: 'second-seat', task: 'another', percent: 100, checklist: [{ item: 'done', done: true }], blockers: [] },
    ]);
    const ready = new ExecutiveOperationsHqAdapter({ handoffsDir });
    expect(ready.readiness()).toBe('ready');

    const result = await ready.invoke({
      tenantId: 't1',
      installationId: 'i1',
      runId: 'r1',
      workflowTemplateId: 'daily_operations_brief',
      actionType: 'publish_brief',
      input: null,
    });
    expect(result.status).toBe('completed');
    const brief = (result.output as { brief: any }).brief;
    expect(brief.aggregate.seatCount).toBe(2);
    expect(brief.aggregate.meanPercent).toBe(Math.round((FIXTURE_PERCENT + 100) / 2));
    expect(brief.seats.map((s: any) => s.seat)).toContain(FIXTURE_SEAT);
    expect(result.externalReferences.some((r) => r.startsWith('client-ops://hq/handoffs/'))).toBe(true);

    // Honest path: an empty/absent source is 'declared', and invoke fails (no fabrication).
    const emptyDir = mkdtempSync(join(tmpdir(), 'hq-empty-'));
    tmpDirs.push(emptyDir);
    const notReady = new ExecutiveOperationsHqAdapter({ handoffsDir: emptyDir });
    expect(notReady.readiness()).toBe('declared');
    const failed = await notReady.invoke({
      tenantId: 't1',
      installationId: 'i1',
      runId: 'r2',
      workflowTemplateId: 'daily_operations_brief',
      actionType: 'publish_brief',
      input: null,
    });
    expect(failed.status).toBe('failed');
  });
});
