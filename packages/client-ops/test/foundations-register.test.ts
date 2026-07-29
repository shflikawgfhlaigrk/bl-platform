import { describe, expect, it } from 'vitest';
import { registerReadyFoundations } from '../src/foundations';

/**
 * registerReadyFoundations() is the honest source of truth for which of the 29
 * products have a verified execution adapter wired into the runtime registry.
 * This asserts the set — registration only, no invoke — so it is environment
 * independent (no disk / psql needed to confirm the wiring).
 */
describe('registerReadyFoundations', () => {
  it('wires the verified own-infra execution adapters into the registry', () => {
    const registry = registerReadyFoundations();
    const connected = registry
      .list()
      .filter((f) => f.connected)
      .map((f) => f.capabilityId)
      .sort();

    expect(connected).toContain('client_ops.workflow.execute'); // Workflow Operating System
    expect(connected).toContain('client_ops.hq.publish_brief'); // Executive Operations HQ
    expect(connected).toContain('client_ops.data.execute_job'); // Data Operations Service
    expect(connected).toContain('client_ops.sales.process_lead'); // Sales Operator
    expect(connected.length).toBeGreaterThanOrEqual(4);
  });
});
