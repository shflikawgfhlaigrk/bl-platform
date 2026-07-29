import { describe, expect, it } from 'vitest';
import { ServiceFoundationRegistry, type FoundationInvocationRequest } from '../src/adapters';
import {
  DataOperationsAdapter,
  type DataSliceRow,
  type DataSourceReader,
} from '../src/foundations/data-operations-service';
import { executeRun } from '../src/runner';
import { ClientOpsService } from '../src/service';
import { createActiveInstallation, createInstallation, createRun, headers, setup } from './helpers';

/**
 * Runtime proof for the Data Operations Service execution adapter
 * (service `data-operations-service`, capability `client_ops.data.execute_job`,
 * owned source `BlackLabelPropertyHarvest.jobs`). Mirrors runner.test.ts but drives
 * a `data-operations-service` installation.
 *
 * The adapter runs ONE checkpointed, READ-ONLY slice over an owned data source. In
 * production the injected reader is `createNationalPropertyRecordsReader()`, which
 * SELECTs a quality-gated page of the real `national_property_records` table on psql
 * :5433 (db `blacklabel`) — the imported payload of the `BlackLabelPropertyHarvest.jobs`
 * (`harvest_runs`) ledger. Here we inject a DETERMINISTIC reader with the same shape
 * so the accepted/rejected/next-checkpoint assertions are exact and hermetic — the
 * counts are computed from the rows the reader returns, never hardcoded in the adapter.
 */

/**
 * A fixed slice mirroring `national_property_records` semantics: rows keyed by an
 * ascending id `checkpoint`, each tagged by the quality gate (accepted iff it has a
 * parcel id and is not suppressed). 6 accepted + 2 rejected across ids 3..10.
 */
const FIXTURE_SLICE: DataSliceRow[] = [
  { checkpoint: 3, accepted: true },
  { checkpoint: 4, accepted: true },
  { checkpoint: 5, accepted: false, rejectReason: 'missing_parcel_id' },
  { checkpoint: 6, accepted: true },
  { checkpoint: 7, accepted: true },
  { checkpoint: 8, accepted: false, rejectReason: 'suppressed' },
  { checkpoint: 9, accepted: true },
  { checkpoint: 10, accepted: true },
];
const FIXTURE_CEILING = 10;

/** Deterministic, read-only reader: resumes past `afterCheckpoint`, honours `limit`, self-consistent readback. */
function deterministicReader(): DataSourceReader {
  return async ({ source, afterCheckpoint, limit }) => {
    const rows = FIXTURE_SLICE.filter((row) => row.checkpoint > afterCheckpoint).slice(0, limit);
    const readbackAcceptedCount = rows.filter((row) => row.accepted).length;
    return { source, rows, sourceCeiling: FIXTURE_CEILING, readbackAcceptedCount };
  };
}

function directRequest(overrides: Partial<FoundationInvocationRequest> = {}): FoundationInvocationRequest {
  return {
    tenantId: 't1',
    installationId: 'i1',
    runId: 'r-direct',
    workflowTemplateId: 'scheduled_data_job',
    actionType: 'read_checkpoint',
    input: { checkpoint: 0, limit: 8 },
    ...overrides,
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

describe('data-operations-service foundation adapter', () => {
  it('drives a requested data-operations run to success and writes a real, persisted completion receipt', async () => {
    const { db, events, app, tenantA } = await setup();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallationFor(app, tenantA, 'data-operations-service');
    expect(installation.catalogId).toBe('data-operations-service');
    const run = await createRun(app, tenantA, installation);
    expect(run.status).toBe('requested');

    const adapter = new DataOperationsAdapter({ reader: deterministicReader() });
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
      expect(receipt.summary).toContain('client_ops.data.execute_job');
      // Evidence deep-links to the module-owned source checkpoint the slice reached.
      expect(JSON.stringify(receipt.verification)).toContain(
        'client-ops://data-ops/national_property_records/checkpoint/10',
      );

      // Counts are derived from the reader's rows — prove they are not fabricated.
      const firstResult = outcome.results[0];
      expect(firstResult).toBeDefined();
      const output = firstResult.output as {
        accepted: number;
        rejected: number;
        nextCheckpoint: number;
        readOnly: boolean;
        destinationReadback: { confirmedAccepted: number; matchesAccepted: boolean };
      };
      expect(output.accepted).toBe(6);
      expect(output.rejected).toBe(2);
      expect(output.nextCheckpoint).toBe(10);
      expect(output.readOnly).toBe(true);
      expect(output.destinationReadback).toEqual({ confirmedAccepted: 6, matchesAccepted: true });
    }
  });

  it('fails honestly with no receipt when no adapter is connected — never fabricates success', async () => {
    const { db, events, app, tenantA } = await setup();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallationFor(app, tenantA, 'data-operations-service');
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

  it('runs a real checkpointed slice via registry.invoke and resumes from the cursor', async () => {
    const registry = new ServiceFoundationRegistry();
    registry.register(new DataOperationsAdapter({ reader: deterministicReader() }));

    // First slice from checkpoint 0: reads ids 3..10 → 6 accepted, 2 rejected, next = 10.
    const first = await registry.invoke('client_ops.data.execute_job', directRequest());
    expect(first.status).toBe('completed');
    const firstOut = first.output as {
      source: string;
      accepted: number;
      rejected: number;
      nextCheckpoint: number;
      mappingVersion: string;
      readOnly: boolean;
      sourceRange: { afterCheckpoint: number; throughCheckpoint: number; sourceCeiling: number | null };
      destinationReadback: { confirmedAccepted: number; matchesAccepted: boolean };
      rejects: Array<{ checkpoint: number; reason: string }>;
    };
    expect(firstOut.source).toBe('national_property_records');
    expect(firstOut.accepted).toBe(6);
    expect(firstOut.rejected).toBe(2);
    expect(firstOut.nextCheckpoint).toBe(10);
    expect(firstOut.readOnly).toBe(true);
    expect(firstOut.mappingVersion).toBe('property-harvest.records.v1');
    expect(firstOut.sourceRange).toMatchObject({ afterCheckpoint: 0, throughCheckpoint: 10, sourceCeiling: 10 });
    expect(firstOut.destinationReadback).toEqual({ confirmedAccepted: 6, matchesAccepted: true });
    expect(firstOut.rejects).toEqual([
      { checkpoint: 5, reason: 'missing_parcel_id' },
      { checkpoint: 8, reason: 'suppressed' },
    ]);
    expect(first.externalReferences).toContain(
      'client-ops://data-ops/national_property_records/checkpoint/10',
    );

    // Resume past checkpoint 6: reads ids 7..10 → 3 accepted (7,9,10), 1 rejected (8).
    const resumed = await registry.invoke(
      'client_ops.data.execute_job',
      directRequest({ runId: 'r-resume', input: { checkpoint: 6, limit: 8 } }),
    );
    expect(resumed.status).toBe('completed');
    const resumedOut = resumed.output as { accepted: number; rejected: number; nextCheckpoint: number };
    expect(resumedOut.accepted).toBe(3);
    expect(resumedOut.rejected).toBe(1);
    expect(resumedOut.nextCheckpoint).toBe(10);
  });

  it('is declared and fails honestly when no source reader is wired — the anti-vapor guarantee', async () => {
    const declared = new DataOperationsAdapter();
    expect(declared.readiness()).toBe('declared');
    // Identity still matches the declaration, so it registers…
    const registry = new ServiceFoundationRegistry();
    registry.register(declared);
    // …but the registry refuses to invoke a not-ready adapter (never a fake completion).
    await expect(registry.invoke('client_ops.data.execute_job', directRequest())).rejects.toThrow();
    // A direct invoke on the declared adapter returns an honest failure, not invented counts.
    const failed = await declared.invoke(directRequest());
    expect(failed.status).toBe('failed');
    expect(failed.externalReferences).toHaveLength(0);
  });
});
