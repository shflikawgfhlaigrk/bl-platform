import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const exists = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
async function verify(directory) {
  if (manifest.brand !== 'BlackLabel' || manifest.package !== 'business-platform' || !Array.isArray(manifest.files)) throw Error('Invalid BlackLabel package.');
  const seen = new Set();
  for (const row of manifest.files) {
    if (!row.path || path.isAbsolute(row.path) || row.path.split('/').some(p => !p || p === '..' || p === '.') || seen.has(row.path)) throw Error('Invalid package path.');
    seen.add(row.path);
    const file = path.join(directory, row.path);
    if (!(await fs.lstat(file)).isFile() || !(await fs.realpath(file)).startsWith(`${await fs.realpath(directory)}${path.sep}`)) throw Error('Package contains an unsafe file.');
    const bytes = await fs.readFile(file);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw Error(`Package verification failed: ${row.path}`);
  }
  for (const required of ['runtime/bin/node', 'server.mjs', 'install.mjs']) if (!seen.has(required)) throw Error(`Missing package file: ${required}`);
}
await verify(source);
if (manifest.target !== `${process.platform}-${process.arch}`) throw Error(`This package targets ${manifest.target}.`);
let root = path.join(os.homedir(), '.blacklabel-business'), service = true;
const supplied = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--no-service') { service = false; continue; }
  if (!['--root', '--port', '--host', '--public-origin', '--tls-cert', '--tls-key'].includes(arg) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw Error(`Invalid option: ${arg}`);
  const value = process.argv[++i];
  if (arg === '--root') root = path.resolve(value); else supplied[arg.slice(2)] = value;
}
if ([path.parse(root).root, os.homedir(), source].includes(root) || source.startsWith(`${root}${path.sep}`)) throw Error('Choose a dedicated installation directory outside the extracted package.');
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const lock = path.join(root, '.installer-lock');
try { await fs.mkdir(lock, { mode: 0o700 }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const owner = await read(path.join(lock, 'owner.json')).then(b => b && JSON.parse(b));
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) throw Error('Installation lock needs review before another upgrade.');
  try { process.kill(owner.pid, 0); throw Error('Another installer is running.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await fs.rm(lock, { recursive: true }); await fs.mkdir(lock, { mode: 0o700 });
}
await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
const app = path.join(root, 'app'), data = path.join(root, 'data'), logs = path.join(root, 'logs');
const stage = path.join(root, `app.pending-${crypto.randomUUID()}`), previous = path.join(root, 'versions', `before-${Date.now()}`);
const settingsFile = path.join(root, 'installation.json');
const label = `com.blacklabel.business.${hash(root).slice(0, 12)}`, domain = `gui/${process.getuid()}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const launch = (...args) => execFileSync('/bin/launchctl', args, { stdio: 'pipe' });
let oldSettings, oldPlist, wasRunning = false, stopped = false, moved = false, promoted = false, backup, old;
async function health(config) {
  if (!config.publicOrigin) return fetch(`http://127.0.0.1:${config.port}/api/business/health`, { signal: AbortSignal.timeout(1000) }).then(r => { if (!r.ok) throw Error('Unhealthy service'); return r.json(); });
  const url = new URL(config.publicOrigin);
  return new Promise(async (resolve, reject) => {
    try {
      const request = https.get({ hostname: config.host === '::1' ? '::1' : '127.0.0.1', port: config.port, servername: url.hostname,
        path: '/api/business/health', headers: { Host: url.host }, ca: await fs.readFile(config.tlsCert), timeout: 1000 }, response => {
        let body = ''; response.on('data', b => body += b); response.on('end', () => { try { if (response.statusCode !== 200) throw Error('Unhealthy service'); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
      });
      request.on('timeout', () => request.destroy(Error('Startup check timed out'))); request.on('error', reject);
    } catch (error) { reject(error); }
  });
}
async function ready(config, buildId) {
  for (let i = 0; i < 60; i++) {
    try {
      const h = await health(config), identity = JSON.parse(await fs.readFile(path.join(data, 'identity.json'), 'utf8'));
      if (h.data?.buildId === buildId && h.data.installationId === identity.tenantId) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('Installed business service did not pass its identity and startup check.');
}
try {
  oldSettings = await read(settingsFile); old = oldSettings ? JSON.parse(oldSettings) : {};
  oldPlist = await read(plist);
  try { launch('print', `${domain}/${label}`); wasRunning = true; } catch {}
  if (!service && wasRunning) throw Error('Stop this installation before an offline upgrade, or use the service installer.');
  const config = { port: Number(supplied.port ?? old.port ?? 47832), host: supplied.host ?? old.host ?? '127.0.0.1',
    publicOrigin: supplied['public-origin'] ?? old.publicOrigin, tlsCert: supplied['tls-cert'] ? path.resolve(supplied['tls-cert']) : old.tlsCert,
    tlsKey: supplied['tls-key'] ? path.resolve(supplied['tls-key']) : old.tlsKey };
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('Choose a port between 1024 and 65535.');
  if (!['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::'].includes(config.host)) throw Error('Choose a loopback or wildcard listen address.');
  if (config.publicOrigin || config.tlsCert || config.tlsKey) {
    if (!config.publicOrigin || !config.tlsCert || !config.tlsKey) throw Error('Provide the public origin, TLS certificate and private key together.');
    const url = new URL(config.publicOrigin);
    if (url.protocol !== 'https:' || url.origin !== config.publicOrigin || Number(url.port || 443) !== config.port) throw Error('Use the exact HTTPS origin and matching port.');
    await fs.access(config.tlsCert); await fs.access(config.tlsKey);
  } else if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) throw Error('Shared access requires an HTTPS origin and TLS certificate.');
  await fs.mkdir(stage, { mode: 0o700 });
  for (const row of manifest.files) {
    const target = path.join(stage, row.path); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, row.path), target); await fs.chmod(target, (await fs.stat(path.join(source, row.path))).mode & 0o777);
  }
  await fs.copyFile(path.join(source, 'manifest.json'), path.join(stage, 'manifest.json')); await verify(stage);
  if (wasRunning) { launch('bootout', `${domain}/${label}`); stopped = true; }
  if (await exists(path.join(data, 'platform.db'))) {
    const backupResult = execFileSync(path.join(app, 'runtime/bin/node'), [path.join(app, 'server.mjs'), 'backup'], { encoding: 'utf8', env: { ...process.env, BLACKLABEL_BUSINESS_DATA: data }, timeout: 60000 });
    backup = JSON.parse(backupResult);
  }
  if (await exists(app)) { await fs.mkdir(path.dirname(previous), { recursive: true }); await fs.rename(app, previous); moved = true; }
  await fs.rename(stage, app); promoted = true;
  for (const dir of [data, logs]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(settingsFile, JSON.stringify({ brand: 'BlackLabel', version: manifest.version, buildId: manifest.buildId, sourceSha256: manifest.sourceSha256,
    label, ...config, service, installedAt: new Date().toISOString(), backup }, null, 2), { mode: 0o600 });
  if (service) {
    const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    const env = { BLACKLABEL_BUSINESS_DATA: data, BLACKLABEL_BUSINESS_PORT: config.port, BLACKLABEL_BUSINESS_HOST: config.host,
      ...(config.publicOrigin ? { BLACKLABEL_BUSINESS_PUBLIC_ORIGIN: config.publicOrigin, BLACKLABEL_BUSINESS_TLS_CERT: config.tlsCert, BLACKLABEL_BUSINESS_TLS_KEY: config.tlsKey } : {}) };
    await fs.mkdir(path.dirname(plist), { recursive: true });
    await fs.writeFile(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(path.join(app, 'runtime/bin/node'))}</string><string>${xml(path.join(app, 'server.mjs'))}</string></array><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(logs, 'runtime.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(logs, 'error.log'))}</string></dict></plist>`, { mode: 0o600 });
    launch('bootstrap', domain, plist); await ready(config, manifest.buildId);
  }
  console.log(JSON.stringify({ installed: true, brand: 'BlackLabel', root, version: manifest.version, buildId: manifest.buildId, service,
    url: config.publicOrigin ?? `http://127.0.0.1:${config.port}`, accessKeyFile: path.join(data, 'access.token'), previousVersion: moved ? previous : null, backup }, null, 2));
} catch (error) {
  const recovery = [];
  if (service && promoted) { try { launch('bootout', `${domain}/${label}`); } catch {} }
  try {
    if (promoted) await fs.rename(app, `${app}.failed-${Date.now()}`);
    if (moved) await fs.rename(previous, app);
    if (backup && moved) execFileSync(path.join(app, 'runtime/bin/node'), [path.join(app, 'server.mjs'), 'restore', path.join(data, 'backups', backup.name)], { env: { ...process.env, BLACKLABEL_BUSINESS_DATA: data }, stdio: 'pipe', timeout: 60000 });
    if (oldSettings) await fs.writeFile(settingsFile, oldSettings, { mode: 0o600 }); else if (promoted) await fs.rm(settingsFile, { force: true });
    if (service && (stopped || promoted)) {
      if (oldPlist) await fs.writeFile(plist, oldPlist, { mode: 0o600 }); else await fs.rm(plist, { force: true });
      if (wasRunning && oldPlist) { launch('bootstrap', domain, plist); if (old.buildId) await ready(old, old.buildId); }
    }
  } catch (restoreError) { recovery.push(restoreError.message); }
  await fs.writeFile(path.join(root, `installation-failure-${Date.now()}.json`), JSON.stringify({ error: error.message, previousApplicationRestored: moved, previousServiceRestarted: wasRunning && !recovery.length && (stopped || promoted), recoveryErrors: recovery }, null, 2), { mode: 0o600 });
  if (recovery.length) throw new AggregateError([error, ...recovery.map(s => Error(s))], 'Installation failed; review the retained recovery report.');
  throw error;
} finally {
  await fs.rm(stage, { recursive: true, force: true }); await fs.rm(lock, { recursive: true, force: true });
}
