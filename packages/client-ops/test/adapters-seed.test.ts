import { describe, expect, it, vi } from 'vitest';
import {
  SERVICE_EXECUTION_FOUNDATIONS,
  ServiceFoundationRegistry,
  seedClientOps,
  type ServiceFoundationAdapter,
} from '../src';
import { setup } from './helpers';

describe('client-ops execution foundations', () => {
  it('declares an invoke/verify boundary for all eight services and seven vertical packs', () => {
    expect(SERVICE_EXECUTION_FOUNDATIONS).toHaveLength(15);
    expect(new Set(SERVICE_EXECUTION_FOUNDATIONS.map((item) => item.serviceId))).toEqual(new Set([
      'workflow-operating-system', 'ai-front-desk', 'sales-operator', 'marketing-operator',
      'support-operator', 'executive-operations-hq', 'private-company-agent', 'data-operations-service',
      'medical-dental-receptionist', 'real-estate-acquisition-desk', 'home-services-lead-scheduling-operator',
      'law-firm-intake-document-routing', 'property-management-maintenance-desk',
      'ecommerce-support-marketing-operator', 'local-business-review-reactivation-system',
    ]));
    for (const item of SERVICE_EXECUTION_FOUNDATIONS) {
      expect(item.capabilityId).toMatch(/^client_ops\.[a-z_]+\.[a-z_]+$/);
      expect(item.ownedSourceIdentifier).not.toBe('');
      expect(item.requiredFoundationIdentifiers.length).toBeGreaterThan(0);
      expect(item.invokeBoundary).not.toBe('');
      expect(item.verifyBoundary).not.toBe('');
    }
  });

  it('registers, invokes, and verifies only identity-matched ready adapters', async () => {
    const declaration = SERVICE_EXECUTION_FOUNDATIONS[0];
    const invoke = vi.fn(async () => ({ invocationId: 'inv-1', status: 'completed' as const, output: { ok: true }, externalReferences: ['ext-1'] }));
    const verify = vi.fn(async () => ({ verified: true, evidence: { readback: true }, checkedAt: '2026-07-15T12:00:00.000Z' }));
    const adapter: ServiceFoundationAdapter = {
      serviceId: declaration.serviceId,
      capabilityId: declaration.capabilityId,
      ownedSourceIdentifier: declaration.ownedSourceIdentifier,
      readiness: () => 'ready', invoke, verify,
    };
    const registry = new ServiceFoundationRegistry();
    expect(registry.list()).toHaveLength(15);
    await expect(registry.invoke(declaration.capabilityId, {
      tenantId: 't', installationId: 'i', runId: 'r', workflowTemplateId: 'w', actionType: 'execute', input: {},
    })).rejects.toMatchObject({ status: 501 });
    registry.register(adapter);
    expect(registry.list().find((item) => item.capabilityId === declaration.capabilityId)).toMatchObject({ connected: true, adapterReadiness: 'ready' });
    await expect(registry.invoke(declaration.capabilityId, {
      tenantId: 't', installationId: 'i', runId: 'r', workflowTemplateId: 'w', actionType: 'execute', input: {},
    })).resolves.toMatchObject({ invocationId: 'inv-1', status: 'completed' });
    await expect(registry.verify(declaration.capabilityId, {
      tenantId: 't', installationId: 'i', runId: 'r', invocationId: 'inv-1', expected: {},
    })).resolves.toMatchObject({ verified: true });
    expect(invoke).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
  });
});

describe('client-ops seed', () => {
  it('is idempotent and leaves the demo in safe onboarding state', async () => {
    const { db, events, tenantA } = await setup();
    const first = await seedClientOps(db, events, tenantA.id);
    const second = await seedClientOps(db, events, tenantA.id);
    expect(second.id).toBe(first.id);
    expect(first.status).toBe('onboarding');
    expect(first.connectors.every((item) => item.status === 'pending')).toBe(true);
    expect(first.onboarding.every((item) => item.status === 'pending')).toBe(true);
  });
});
