import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const settings = readFileSync(path.resolve(here, '../public/js/views/settings.js'), 'utf8');

describe('POS owner/admin settings static contract', () => {
  it('loads settings, readiness, and active inventory locations from authoritative endpoints', () => {
    expect(settings).toContain("button('Point of sale'");
    expect(settings).toContain("getData('/api/pos/settings')");
    expect(settings).toContain("getData('/api/pos/readiness')");
    expect(settings).toContain("getData('/api/inventory/locations')");
    expect(settings).toContain('location.archived !== 1 && location.archived !== true');
  });

  it('saves location, integer-basis-point tax, and receipt footer through the owner/admin endpoint', () => {
    expect(settings).toContain("select('defaultLocationId'");
    expect(settings).toContain("name: 'taxPercent'");
    expect(settings).toContain("name: 'receiptFooter'");
    expect(settings).toContain('const taxBps = parsePercentToBps(tax.value)');
    expect(settings).toContain("await mutate('/api/pos/settings', 'PUT', {");
    expect(settings).toContain('defaultLocationId: location.value');
    expect(settings).toContain('receiptFooter: receiptFooter.value.trim() || null');
  });

  it('surfaces readiness blockers verbatim and never equates provider configuration with reader verification', () => {
    expect(settings).toContain('blocker.message');
    expect(settings).toContain('blocker.blocking');
    expect(settings).toContain('cardPresent.physicalReaderVerified');
    expect(settings).toContain('cardPresent.configured');
    expect(settings).toContain('Provider configured; physical reader not verified');
    expect(settings).toContain('does not verify a connected physical reader');
  });

  it('shows durable reconciliation status and gives an authorized owner a repair control', () => {
    expect(settings).toContain("getData('/api/pos/reconciliation')");
    expect(settings).toContain("'Pending effects': pendingEffects");
    expect(settings).toContain("'Effects with errors'");
    expect(settings).toContain("button('Run POS reconciliation'");
    expect(settings).toContain("mutate('/api/pos/reconciliation/drain', 'POST'");
  });
});
