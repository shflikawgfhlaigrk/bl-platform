import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

if (process.argv.length !== 5) throw Error('Provide CANDIDATE_ARCHIVE, BASELINE_ARCHIVE, NEW_EVIDENCE_DIRECTORY.');
const [archive, baseline, out] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(out, { recursive: false, mode: 0o700 });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const checks = [], root = path.join(out, 'installation'), data = path.join(root, 'data');
const label = `com.blacklabel.business.${sha(root).slice(0, 12)}`, domain = `gui/${process.getuid()}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const launch = (...args) => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: 'pipe' });
async function extract(file, name) {
  const dir = path.join(out, name); await fs.mkdir(dir);
  const entries = execFileSync('/usr/bin/tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
  assert(entries.every(p => !path.isAbsolute(p) && !p.split('/').includes('..')));
  const tops = new Set(entries.map(p => p.split('/')[0])); assert.equal(tops.size, 1);
  execFileSync('/usr/bin/tar', ['-xzf', file, '-C', dir]); return path.join(dir, [...tops][0]);
}
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function install(source, args = []) { return JSON.parse(execFileSync('/bin/bash', [path.join(source, 'install.sh'), '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 90000 })); }
function pidAndParents() {
  const details = launch('print', `${domain}/${label}`), pid = Number(details.match(/^\s*pid = (\d+)/m)?.[1]);
  assert(Number.isInteger(pid) && pid > 1); const chain = []; let cursor = pid;
  while (cursor > 1) { const row = execFileSync('/bin/ps', ['-p', String(cursor), '-o', 'ppid=', '-o', 'command='], { encoding: 'utf8' }).trim(); const match = row.match(/^(\d+)\s+(.+)$/); assert(match); chain.push({ pid: cursor, parent: Number(match[1]), command: match[2] }); cursor = Number(match[1]); assert(chain.length < 32); }
  assert(chain[0].command.includes(path.join(root, 'app', 'runtime/bin/node')));
  assert.equal(cursor, 1); return { pid, chain };
}
let blocker, token, base, ca;
async function request(route, method = 'GET', body, headers = {}) {
  const url = new URL(route, base); const tls = url.protocol === 'https:';
  const result = await new Promise((resolve, reject) => {
    const req = (tls ? https : http).request(url, { method, agent: false, ...(tls ? { ca, servername: url.hostname } : {}), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, timeout: 5000 }, response => {
      const chunks = []; response.on('data', b => chunks.push(b)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('Request timed out'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { ...result, json: () => JSON.parse(result.text) };
}
try {
  const previous = await extract(baseline, 'baseline'), candidate = await extract(archive, 'candidate');
  const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'));
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  const first = install(previous, ['--port', String(port)]); await fs.writeFile(path.join(out, 'baseline-installation.json'), JSON.stringify(first, null, 2));
  token = (await fs.readFile(path.join(data, 'access.token'), 'utf8')).trim();
  const created = await request('/api/crm/customers', 'POST', { name: 'Service upgrade acceptance fixture' }); assert.equal(created.status, 201, created.text); const customerId = created.json().data.id;
  const beforeIdentity = JSON.parse(await fs.readFile(path.join(data, 'identity.json'), 'utf8'));
  const upgraded = install(candidate); assert(upgraded.previousVersion && upgraded.backup); assert.equal(upgraded.buildId, manifest.buildId);
  assert.equal((await request('/api/business/health')).json().data.buildId, manifest.buildId);
  assert.equal((await request('/api/crm/customers')).json().data[0].id, customerId);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'identity.json'), 'utf8')), beforeIdentity);
  checks.push('LaunchAgent installation and upgrade from previous archived build preserve the customer and installation identity');
  const beforeSettings = await fs.readFile(path.join(root, 'installation.json')), beforePlist = await fs.readFile(plist);
  blocker = http.createServer((_request, response) => { response.writeHead(503, { Connection: 'close' }); response.end(); }); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  let failed = false;
  try { install(candidate, ['--port', String(blocker.address().port)]); } catch (error) { failed = true; await fs.writeFile(path.join(out, 'expected-startup-failure.log'), String(error.stderr ?? error.message)); }
  assert(failed, 'Occupied port must fail startup'); blocker.closeAllConnections(); await new Promise(resolve => blocker.close(resolve)); blocker = undefined;
  assert.deepEqual(await fs.readFile(path.join(root, 'installation.json')), beforeSettings); assert.deepEqual(await fs.readFile(plist), beforePlist);
  assert.equal((await request('/api/business/health')).json().data.buildId, manifest.buildId);
  assert.equal((await request('/api/crm/customers')).json().data[0].id, customerId);
  const failureNames = (await fs.readdir(root)).filter(n => n.startsWith('installation-failure-'));
  const failure = JSON.parse(await fs.readFile(path.join(root, failureNames.at(-1)), 'utf8')); assert.equal(failure.previousServiceRestarted, true); assert.deepEqual(failure.recoveryErrors, []);
  checks.push('occupied-port upgrade failure restores database, application, exact service configuration, and running previous service');
  const observed = pidAndParents(); await fs.writeFile(path.join(out, 'owned-service-parent-chain.json'), JSON.stringify(observed, null, 2));
  const stopped = execFileSync('/Users/michaelbarber/.codex/bin/safe-terminate-helper', [String(observed.pid)], { encoding: 'utf8', timeout: 10000 });
  await fs.writeFile(path.join(out, 'owned-service-restart.log'), stopped);
  let recovered = false;
  for (let i = 0; i < 80; i++) {
    try { const h = await request('/api/business/health'); if (h.json().data.buildId === manifest.buildId && pidAndParents().pid !== observed.pid) { recovered = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(recovered); assert.equal((await request('/api/crm/customers')).json().data[0].id, customerId);
  checks.push('LaunchAgent recovers after owned runtime termination with customer data retained');
  const cert = path.join(out, 'fixture-tls.pem'), key = path.join(out, 'fixture-tls.key');
  const config = path.join(out, 'fixture-openssl.conf');
  await fs.writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', config, '-keyout', key, '-out', cert], { stdio: 'pipe' }); await fs.chmod(key, 0o600);
  const tlsPort = await freePort(); base = `https://localhost:${tlsPort}`; ca = await fs.readFile(cert);
  install(candidate, ['--port', String(tlsPort), '--host', '0.0.0.0', '--public-origin', base, '--tls-cert', cert, '--tls-key', key]);
  const health = await request('/api/business/health'); assert.equal(health.status, 200); assert.equal(health.json().data.installationId, beforeIdentity.tenantId); assert(health.headers['strict-transport-security']);
  assert.equal((await request('/api/crm/customers', 'GET', undefined, { Host: `foreign.example:${tlsPort}` })).status, 403);
  assert.equal((await request('/api/crm/customers', 'GET', undefined, { Origin: 'https://foreign.example' })).status, 403);
  const login = await request('/api/business/login', 'POST', { token }); assert.equal(login.status, 200); assert(login.headers['set-cookie'].some(s => s.includes('Secure') && s.includes('HttpOnly')));
  assert.equal((await request('/api/crm/customers')).json().data[0].id, customerId);
  assert.equal((await request('/api/business/settings')).json().data.publicOrigin, base);
  checks.push('installed HTTPS service accepts its certificate and hostname, retains customer records, sets secure cookies, rejects foreign hosts and origins');
  await fs.writeFile(path.join(out, 'ACCEPTANCE.json'), JSON.stringify({ kind: 'business-service-and-transport-acceptance', checkedAt: new Date().toISOString(), buildId: manifest.buildId,
    archiveSha256: sha(await fs.readFile(archive)), baselineSha256: sha(await fs.readFile(baseline)), sourceSha256: manifest.sourceSha256, status: 'passed', checks,
    commercialAcceptance: 'pending', publicInternetReachability: 'not-tested', tls: 'isolated local fixture certificate; no system trust changes' }, null, 2));
  console.log(JSON.stringify({ buildId: manifest.buildId, checks, status: 'passed' }, null, 2));
} catch (error) { await fs.writeFile(path.join(out, 'FAILURE.json'), JSON.stringify({ error: error.message, checks }, null, 2)); throw error; }
finally {
  if (blocker) { blocker.closeAllConnections(); await new Promise(resolve => blocker.close(resolve)); }
  try { pidAndParents(); launch('bootout', `${domain}/${label}`); } catch (error) { if (!String(error.message).includes('Could not find service')) { /* Preserve failed service evidence for explicit follow-up. */ } }
  try { launch('print', `${domain}/${label}`); } catch { await fs.rm(plist, { force: true }); }
}
