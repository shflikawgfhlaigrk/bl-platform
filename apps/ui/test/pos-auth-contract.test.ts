import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const auth = readFileSync(path.join(publicDir, 'js/auth.js'), 'utf8');
const api = readFileSync(path.join(publicDir, 'js/api.js'), 'utf8');
const app = readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');

describe('POS operator UI contract', () => {
  it('blocks app boot on a real server-issued operator session', () => {
    expect(app).toContain('await requireOperatorSession()');
    expect(auth).toContain("const AUTH = '/api/pos/auth'");
    expect(auth).toContain("`${AUTH}/session`");
    expect(html).toContain('id="current-user"');
    expect(html).not.toContain('title="Signed-in user">Owner');
  });

  it('provides first-run owner PIN setup, operator selection, and switching', () => {
    expect(auth).toContain('Secure this register');
    expect(auth).toContain('Operator sign in');
    expect(auth).toContain('Switch operator');
    expect(auth).toContain("pattern: '[0-9]{4}'");
    expect(auth).not.toContain('role: z.enum'); // browser never defines authority rules
  });

  it('binds queued mutations to their initiating operator', () => {
    expect(api).toContain('actorId: ACTOR_ID');
    expect(api).toContain("h['x-pos-expected-user-id']");
    expect(auth).toContain('currentSnapshot()');
    expect(auth).toContain('unsynced change');
  });
});
