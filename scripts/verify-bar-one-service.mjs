/** Complete disposable service walkthrough. It refuses a venue without the practice banner/footer. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs';
const origin = process.env.ONECLUB_ACCEPTANCE_ORIGIN;
if (!origin || new URL(origin).pathname !== '/') throw Error('Supply the disposable practice origin');
const output = '.storage/bar-one-full-service-acceptance'; mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
const page = await context.newPage(); page.setDefaultTimeout(12000);
const errors = [], prints = [], submitted = new Set(); const stages = [];
page.on('pageerror', error => errors.push(error.message));
await page.exposeBinding('__barOneTestPrint', async (_source, request) => {
  const key = `${request.role}:${request.documentId}:${createHash('sha256').update(request.text).digest('hex')}`;
  if (submitted.has(key) && !request.reprint) return { status: 'alreadySubmitted', message: 'Already acknowledged by test printer' };
  submitted.add(key); prints.push(request); return { status: 'submitted', message: 'Test printer acknowledged' };
});
await page.addInitScript(() => { window.barOnePrint = {
  status: async () => ({ configuredRoles: ['receipt', 'bar', 'kitchen'], automaticRoles: ['bar', 'kitchen'] }),
  print: request => window.__barOneTestPrint(request)
}; });
const button = name => page.getByRole('button', { name, exact: true });
const dialog = name => page.getByRole('dialog', { name, exact: true });
const stage = name => { stages.push(name); console.log(name); };
async function data(path) { const response = await page.request.get(origin + path); assert(response.ok(), path); return (await response.json()).data; }
async function waitFor(check, message) { const start = Date.now(); while (Date.now() - start < 18000) { if (await check()) return; await new Promise(r => setTimeout(r, 150)); } throw Error(message); }
try {
  await page.goto(origin + '/#/bar');
  await page.locator('.preview-banner').waitFor();
  assert((await page.locator('.preview-banner').innerText()).includes('PRACTICE MODE'));
  const pin = readFileSync('scripts/bar-ui-preview.ts', 'utf8').match(/bootstrap', \{ pin: '(\d{4})'/)?.[1]; assert(pin);
  await page.getByLabel('PIN', { exact: true }).fill(pin); await button('Sign in').click();
  await button('Service').waitFor();
  const ready = await data('/api/pos/readiness'); assert(ready.settings.receiptFooter.includes('Demonstration receipt')); assert(ready.tenders.cardPresent.enabled);
  const baseline = await data('/api/pos/bar/state');
  const beerBefore = baseline.ingredients.find(i => i.value.name === 'Sample draft servings').value.onHand;
  if (!await data('/api/pos/drawer?drawerRef=one-club-bar')) {
    await button('Setup').click(); await button('Cash shift').click();
    await page.getByLabel('Opening float $', { exact: true }).fill('0.00'); await button('Open drawer').click();
    await dialog('Open drawer shift').waitFor({ state: 'detached' });
  }
  const cashBefore = (await data('/api/pos/drawer?drawerRef=one-club-bar')).reconciliation.effectiveExpectedCents;
  stage('Practice identity and cash shift verified');
  const name = 'Acceptance ' + randomUUID().slice(0, 8);
  await button('+ New').click(); await page.getByLabel('Guest or tab name', { exact: true }).fill(name);
  await page.getByLabel('Table or bar seat', { exact: true }).fill('Test table 7'); await button('Open tab').click();
  await dialog('Open a tab').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /House Lager/ }).click();
  await page.getByRole('button', { name: /Club Burger/ }).click();
  await page.getByRole('radio', { name: /Side salad/ }).check();
  await page.getByLabel('Preparation note', { exact: true }).fill('No onions'); await page.getByRole('button', { name: /^Add to bill ·/ }).click();
  await page.getByRole('button', { name: /^Send round/ }).click();
  await waitFor(() => prints.filter(p => p.text.includes(name) && p.automatic).length === 2, 'Both stations must print');
  assert(prints.some(p => p.role === 'kitchen' && p.text.includes('No onions')));
  stage('Food and drink round routed to separate test printers');
  await page.reload(); await button('Service').waitFor(); await page.waitForTimeout(800);
  assert.equal(prints.filter(p => p.text.includes(name) && p.automatic).length, 2);
  await page.locator('.bar-tab').filter({ hasText: name }).click();
  await button('Split').click(); await button('Split equally').click();
  await dialog('Split this check').waitFor({ state: 'detached' });
  let tab = (await data('/api/pos/bar/state')).tabs.find(t => t.value.name === name);
  const checks = tab.value.checks.filter(c => c.allocations.length);
  assert.equal(checks.length, 2); assert.equal(checks.reduce((sum, c) => sum + c.totalCents, 0), 2640);
  const orderIDs = [];
  for (const [index, check] of checks.entries()) {
    await page.getByRole('combobox', { name: 'Current check', exact: true }).selectOption(check.id);
    await page.getByRole('button', { name: /^Pay check/ }).click(); await button('0%').click();
    await button('Continue to payment').click(); await dialog('Take payment').waitFor();
    await page.getByLabel('Card payment amount', { exact: true }).fill(index === 0 ? '5.00' : '13.20');
    await button('Send to card reader').click();
    if (index === 0) {
      await dialog('Take payment').getByRole('heading', { name: 'Balance $8.20', exact: true }).waitFor();
      await page.getByLabel('Cash received', { exact: true }).fill('10.00');
      await dialog('Take payment').getByText('Change to give: $1.80', { exact: true }).waitFor();
      await button('Collect cash & give change').click();
    }
    await button('View receipt').waitFor(); await button('View receipt').click();
    await dialog('Receipt & refunds').waitFor(); await button('Print receipt').click();
    await waitFor(() => prints.filter(p => p.role === 'receipt').length >= index + 1, 'Receipt must reach printer bridge');
    if (index === 0) {
      await button('Print receipt').click(); await dialog('Print another copy?').waitFor();
      await button('Print another copy').click(); await dialog('Print another copy?').waitFor({ state: 'detached' });
      assert(prints.some(p => p.role === 'receipt' && p.reprint));
      await button('Refund card payment').click(); await page.getByLabel('Refund amount $', { exact: true }).fill('1.00');
      await page.getByLabel('Reason', { exact: true }).fill('Disposable acceptance correction'); await button('Issue refund').click();
      await dialog('Refund original payment').waitFor({ state: 'detached' });
    }
    tab = (await data('/api/pos/bar/state')).tabs.find(t => t.id === tab.id);
    orderIDs.push(tab.value.checks.find(c => c.id === check.id).orderId);
    await dialog('Receipt & refunds').getByRole('button', { name: 'Close', exact: true }).click();
  }
  stage('Equal checks, partial card plus cash, tip review, refund and receipt reprint verified');
  const receipts = await Promise.all(orderIDs.map(id => data('/api/pos/receipts/' + id)));
  assert.equal(receipts.reduce((sum, r) => sum + r.amountPaidCents, 0), 2640);
  assert.equal(receipts.reduce((sum, r) => sum + r.amountRefundedCents, 0), 100);
  assert(prints.filter(p => p.role === 'receipt').every(p => p.text.includes('Transaction ID:')));
  assert.equal((await data('/api/pos/bar/state')).ingredients.find(i => i.value.name === 'Sample draft servings').value.onHand, beerBefore - 1);
  await button('Close tab').click();
  await waitFor(async () => (await data('/api/pos/bar/state')).tabs.find(t => t.id === tab.id).value.status === 'closed', 'Tab did not close');
  const cash = await data('/api/pos/drawer?drawerRef=one-club-bar'); assert.equal(cash.reconciliation.effectiveExpectedCents, cashBefore + 820);
  await button('Setup').click(); await button('Cash shift').click(); await button('Close drawer').click();
  await page.getByLabel('Cash counted $', { exact: true }).fill((cash.reconciliation.effectiveExpectedCents / 100).toFixed(2));
  await page.getByLabel('Closing note', { exact: true }).fill('Disposable acceptance complete'); await button('Close shift').click();
  await dialog('Close drawer shift').waitFor({ state: 'detached' });
  const recoveryName = name + ' recovery'; let lost = false;
  await page.route('**/api/pos/bar/tabs', async route => {
    if (!lost && route.request().method() === 'POST' && route.request().postDataJSON().name === recoveryName) {
      lost = true; await route.fetch(); await route.abort('failed');
    } else await route.continue();
  });
  await button('+ New').click(); await page.getByLabel('Guest or tab name', { exact: true }).fill(recoveryName); await button('Open tab').click();
  await waitFor(() => lost, 'Response-loss test did not run'); await page.waitForTimeout(500);
  await dialog('Open a tab').getByRole('button', { name: 'Close', exact: true }).click();
  await button('Recover last action').click(); await button('Recover last action').waitFor({ state: 'detached' });
  const recovered = (await data('/api/pos/bar/state')).tabs.filter(t => t.value.name === recoveryName); assert.equal(recovered.length, 1);
  stage('Lost response recovered with one tab; no duplicate business action');
  await page.locator('.bar-tab').filter({ hasText: recoveryName }).click();
  await button('Close tab').click();
  await waitFor(async () => (await data('/api/pos/bar/state')).tabs.find(t => t.id === recovered[0].id).value.status === 'closed', 'Recovered tab did not close');
  await page.getByRole('heading', { name: recoveryName, exact: true }).waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: output + '/landscape.png', fullPage: true });
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: output + '/portrait.png', fullPage: true });
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), environment: 'Disposable practice; simulated payments and printer bridge only', stages,
    actualPaymentOrPrintSent: false, orderIDs, capturedCents: 2640, refundedCents: 100, cashCollectedCents: 820,
    printedRequests: prints.filter(p => p.text.includes(name) || p.role === 'receipt').map(({ id, documentId, role, automatic, reprint }) => ({ id, documentId, role, automatic, reprint })), pageErrors: errors };
  writeFileSync(output + '/result.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} catch (error) { await page.screenshot({ path: output + '/failure.png', fullPage: true }).catch(() => {}); console.error(error); process.exitCode = 1; }
finally { await browser.close(); }
