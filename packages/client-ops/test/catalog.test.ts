import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_OPS_CATALOG,
  CLIENT_OPS_MANIFEST_SHA256,
  canonicalManifestJson,
  manifestSha256,
  signManifest,
  validateClientOpsCatalog,
  verifyManifest,
  type ClientOpsCatalog,
} from '../src';

describe('client-ops catalog', () => {
  it('contains exactly the documented 8 services, 7 vertical packs, and 2 engagement models', () => {
    expect(CLIENT_OPS_CATALOG.services.map((item) => item.name)).toEqual([
      'Workflow Operating System', 'AI Front Desk', 'Sales Operator', 'Marketing Operator',
      'Support Operator', 'Executive Operations HQ', 'Private Company Agent', 'Data Operations Service',
    ]);
    expect(CLIENT_OPS_CATALOG.verticalPacks.map((item) => item.name)).toEqual([
      'Medical/Dental Receptionist', 'Real-Estate Acquisition Desk',
      'Home-Services Lead and Scheduling Operator', 'Law-Firm Intake and Document Routing',
      'Property-Management Maintenance Desk', 'E-Commerce Support and Marketing Operator',
      'Local-Business Review and Reactivation System',
    ]);
    expect(CLIENT_OPS_CATALOG.engagementModels.map((item) => item.name)).toEqual([
      'Workflow Automation Sprint', 'Managed AI Operations',
    ]);
    expect(() => validateClientOpsCatalog(CLIENT_OPS_CATALOG)).not.toThrow();
  });

  it('has complete operational fields and resolvable workflow references for every service and vertical', () => {
    for (const item of [...CLIENT_OPS_CATALOG.services, ...CLIENT_OPS_CATALOG.verticalPacks]) {
      for (const key of ['id', 'outcomes', 'workflows', 'triggers', 'actions', 'connectors', 'approvals', 'artifacts', 'metrics', 'onboarding', 'foundationIdentifiers'] as const) {
        const value = item[key];
        expect(Array.isArray(value) ? value.length : String(value).length, `${item.id}.${key}`).toBeGreaterThan(0);
      }
      expect(item.readiness.summary).not.toBe('');
      expect(item.readiness.dependencies.length).toBeGreaterThan(0);
      expect(Object.keys(item).some((key) => /price|pricing|fee/i.test(key))).toBe(false);
    }
  });

  it('canonicalizes keys, hashes deterministically, signs, verifies, and rejects tampering', () => {
    expect(canonicalManifestJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(CLIENT_OPS_MANIFEST_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifestSha256(CLIENT_OPS_CATALOG)).toBe(CLIENT_OPS_MANIFEST_SHA256);
    const reordered = JSON.parse(JSON.stringify(CLIENT_OPS_CATALOG)) as Record<string, unknown>;
    const reverseTopLevel = Object.fromEntries(Object.entries(reordered).reverse());
    expect(manifestSha256(reverseTopLevel)).toBe(CLIENT_OPS_MANIFEST_SHA256);

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signature = signManifest(CLIENT_OPS_CATALOG, privateKey);
    expect(signManifest(CLIENT_OPS_CATALOG, privateKey)).toEqual(signature);
    expect(verifyManifest(CLIENT_OPS_CATALOG, signature, publicKey)).toBe(true);
    const tampered = JSON.parse(JSON.stringify(CLIENT_OPS_CATALOG)) as ClientOpsCatalog;
    tampered.services[0].name = 'Tampered';
    expect(verifyManifest(tampered, signature, publicKey)).toBe(false);
  });
});
