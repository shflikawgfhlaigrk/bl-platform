import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs';
const output = '.storage/bar-one-native-acceptance'; mkdirSync(output, { recursive: true });
const source = new Database('.storage/bar-one-venue/platform.db', { readonly: true });
const filename = `${output}/disposable-${Date.now()}.sqlite`;
await source.backup(filename); source.close();
let db = new Database(filename); db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL');
const resource = resolve('apps/ipad/Resources/Register');
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const filename = resolve(resource, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(resource + '/') || !existsSync(filename)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', ({'.js':'application/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml'})[extname(filename)] || 'application/octet-stream');
  res.end(readFileSync(filename));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1180, height: 740 }, serviceWorkers: 'block' });
const page = await context.newPage(); page.setDefaultTimeout(12000);
const errors = [], networkAPIs = []; let cookie = '';
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if(message.text().startsWith('[unhandled]')) errors.push(message.text()); });
page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) networkAPIs.push(request.url()); });
await page.exposeFunction('nativeStore', async message => {
  switch (message.action) {
    case 'open':
      if (db.inTransaction) db.exec('rollback');
      return { masterKey: readFileSync('.storage/bar-one-venue/admin.key').toString('base64'), cookie };
    case 'query': {
      const statement = db.prepare(message.sql);
      const parameters = message.parameters.map(value => typeof value === 'boolean' ? Number(value) : value);
      if (statement.reader) return { rows: statement.all(parameters), changes: '0', insertId: '0' };
      const result = statement.run(parameters);
      return { rows: [], changes: String(result.changes), insertId: String(result.lastInsertRowid) };
    }
    case 'session': cookie = message.cookie; return true;
    case 'runtimeError': errors.push(message.message); return true;
    default: throw Error('Unexpected native action ' + message.action);
  }
});
await page.addInitScript(() => { window.webkit = { messageHandlers: { barOneStore: { postMessage: message => window.nativeStore(message) } } }; });
const data = async path => page.evaluate(async path => { const r = await fetch(path); const body = await r.json(); if (!r.ok) throw Error(JSON.stringify(body)); return body.data; }, path);
const button = name => page.getByRole('button', { name, exact: true });
try {
  await page.goto(origin + '/#/bar');
  await page.getByLabel('PIN', { exact: true }).waitFor();
  const pin = readFileSync('apps/ipad/UITests/PracticeRegisterTests.swift','utf8').match(/testConfiguredPhotoMenu[\s\S]*?pin\.typeText\("(\d+)"\)/)?.[1]; assert(pin);
  await page.getByLabel('PIN', { exact: true }).fill(pin); await button('Sign in').click();
  await button('Service').waitFor();
  const before = await data('/api/pos/bar/state');
  // Connectivity is now removed from the browser. No POS endpoint is served
  // by the test HTTP server; all remaining actions must run in the bundle.
  await context.setOffline(true);
  const tiles = page.locator('.bar-drink'); assert(await tiles.count() > 0);
  await button('Save & next').click();
  await tiles.first().click();
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) await dialog.getByRole('button', { name: /^Add to bill/ }).click();
  await button('Name bill').click(); await page.getByLabel('Bill name', { exact: true }).fill('On-iPad migration check');
  await button('Save bill name').click();
  await page.getByRole('heading', { name: 'On-iPad migration check', exact: true }).waitFor();
  await button('Save & next').click(); await page.getByRole('heading', { name: 'Next guest', exact: true }).waitFor();
  const saved = await data('/api/pos/bar/state');
  const tab = saved.tabs.find(t => t.value.checks.some(c => c.name === 'On-iPad migration check'));
  assert(tab); assert.equal(tab.value.items.length, 1);
  assert.equal(saved.tabs.filter(t => t.value.status === 'open').length, before.tabs.filter(t => t.value.status === 'open').length + 1);
  // Reopen the database, recreate the web runtime, and recover the same session.
  await context.setOffline(false); db.close(); db = new Database(filename); db.pragma('foreign_keys=ON');
  await page.reload(); await button('Service').waitFor(); await context.setOffline(true);
  const recovered = await data('/api/pos/bar/state');
  assert.deepEqual(recovered.tabs.find(t => t.id === tab.id).value, tab.value);
  await page.locator('.bar-tab').filter({ hasText: 'On-iPad migration check' }).click();
  await page.getByRole('heading', { name: 'On-iPad migration check', exact: true }).waitFor();
  await page.screenshot({ path: output + '/saved-ipad-bill.png' });
  for (const endpoint of ['/api/orders/orders','/api/pos/settings','/api/pos/readiness','/api/pos/finance/summary','/api/workforce/roles','/api/admin/credentials','/api/dashboard/owner.json']) {
    await data(endpoint);
  }
  assert.deepEqual(errors, []); assert.deepEqual(networkAPIs, []);
  const result = { checkedAt: new Date().toISOString(), environment: 'Compiled iPad runtime with native SQLite bridge emulated against disposable copy', signInCompatible: true, existingOpenTabs: before.tabs.filter(t=>t.value.status==='open').length, offlineAddRenameSaveNext: true, databaseRestartPersistence: true, sessionRestartPersistence: true, apiNetworkRequests: networkAPIs.length, errors };
  writeFileSync(output + '/result.json', JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message); console.error('Runtime errors:', JSON.stringify(errors));
  console.error((await page.locator('body').innerText()).slice(-2500));
  await page.screenshot({ path: output + '/failure.png' }); process.exitCode = 1;
} finally { await browser.close(); server.close(); db.close(); }
