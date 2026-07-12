import { describe, expect, it } from 'vitest';
import { audit, asCoreDb } from '@blacklabel/core';
import { setup, headers } from './helpers';
import { redact, createLogger } from '../src/redaction';
import { assembleDiagnostics, exportAuditCsv } from '../src/diagnostics';

describe('redact — nested objects, arrays, mixed keys, emails', () => {
  it('strips secret-named keys anywhere in the tree', () => {
    const out = redact({
      host: 'smtp.x.com',
      password: 'hunter2',
      nested: { apiKey: 'sk_live_abc', ok: true },
      list: [{ token: 't1' }, { plain: 'v' }],
      credential_blob: 'zzz',
    });
    expect(out).toEqual({
      host: 'smtp.x.com',
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', ok: true },
      list: [{ token: '[REDACTED]' }, { plain: 'v' }],
      credential_blob: '[REDACTED]',
    });
  });

  it('redacts email-like strings outside the allowlist', () => {
    const out = redact(
      { contact: 'help@mags.com', leaked: 'alice@example.com', note: 'no email here' },
      { emailAllowlist: ['help@mags.com'] },
    );
    expect(out).toEqual({
      contact: 'help@mags.com',
      leaked: '[REDACTED_EMAIL]',
      note: 'no email here',
    });
  });

  it('handles cycles without throwing', () => {
    const a: any = { name: 'x' };
    a.self = a;
    const out = redact(a) as any;
    expect(out.name).toBe('x');
    expect(out.self).toBe('[CIRCULAR]');
  });
});

describe('createLogger — single-line JSON with redaction + correlation id', () => {
  it('emits redacted single-line JSON and returns the record', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), now: () => '2026-07-12T00:00:00.000Z' });
    const rec = log.info('sending mail', {
      correlationId: 'corr-1',
      password: 'hunter2',
      to: 'alice@example.com',
      count: 3,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.correlation_id).toBe('corr-1');
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.to).toBe('[REDACTED_EMAIL]');
    expect(parsed.count).toBe(3);
    expect(rec.level).toBe('info');
  });

  it('can disable redaction', () => {
    const lines: string[] = [];
    const log = createLogger({ redact: false, sink: (l) => lines.push(l) });
    log.warn('x', { password: 'shown' });
    expect(JSON.parse(lines[0]).password).toBe('shown');
  });
});

describe('assembleDiagnostics — redaction pass, no credentials', () => {
  it('produces a redacted bundle', () => {
    const bundle = assembleDiagnostics({
      version: '1.2.3',
      settings: { name: 'Mags', contactEmail: 'help@mags.com', apiKey: 'sk_live' },
      migrations: ['admin.0001_credentials'],
      tableRowCounts: { admin_credentials: 2 },
      health: [{ overall_ok: 1 }],
      recentErrors: [{ msg: 'boom', token: 'secret-token' }],
      emailAllowlist: ['help@mags.com'],
    }) as any;
    expect(bundle.version).toBe('1.2.3');
    expect(bundle.generatedAt).toBeTruthy();
    expect(bundle.settings.apiKey).toBe('[REDACTED]');
    expect(bundle.settings.contactEmail).toBe('help@mags.com'); // allowlisted
    expect(bundle.recentErrors[0].token).toBe('[REDACTED]');
    expect(bundle.tableRowCounts).toEqual({ admin_credentials: 2 });
  });
});

describe('exportAuditCsv — filtered read of core audit_log', () => {
  it('exports a CSV filtered by actor and entity', async () => {
    const { db, tenantA } = await setup();
    const cdb = asCoreDb(db);
    await audit(cdb, tenantA.id, 'owner1', 'admin.settings.updated', 'admin.settings', tenantA.id, {});
    await audit(cdb, tenantA.id, 'owner2', 'admin.credential.saved', 'admin.credential', 'cred_1', {});

    const csv = await exportAuditCsv(db, tenantA.id, { actor: 'owner1' });
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('id,actor,action,entity_type,entity_id,created_at');
    expect(lines).toHaveLength(2); // header + one owner1 row
    expect(lines[1]).toContain('owner1');
    expect(lines[1]).toContain('admin.settings.updated');

    const byEntity = await exportAuditCsv(db, tenantA.id, { entityType: 'admin.credential' });
    expect(byEntity.trim().split('\n')).toHaveLength(2);
  });

  it('is tenant-scoped', async () => {
    const { db, tenantA, tenantB } = await setup();
    await audit(asCoreDb(db), tenantA.id, 'owner1', 'admin.settings.updated', 'admin.settings', tenantA.id, {});
    const csv = await exportAuditCsv(db, tenantB.id, {});
    expect(csv.trim() === '' || csv.trim().split('\n').length === 1).toBe(true);
  });
});
