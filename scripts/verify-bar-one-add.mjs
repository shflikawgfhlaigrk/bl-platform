/** Disposable browser acceptance for first-item add, priced upsells and named bills. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs';
const origin = process.env.ONECLUB_ACCEPTANCE_ORIGIN;
if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw Error('Use an isolated loopback practice server.');
const output = '.storage/bar-one-add-acceptance'; mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } }); page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
const button = name => page.getByRole('button', { name, exact: true });
const data = async path => { const r = await page.request.get(origin + path); assert(r.ok()); return (await r.json()).data; };
try {
  await page.goto(origin + '/#/bar'); await page.locator('.preview-banner').waitFor();
  assert((await page.locator('.preview-banner').innerText()).includes('PRACTICE MODE'));
  if (await button('Sign in').isVisible()) {
    const pin = readFileSync('scripts/bar-ui-preview.ts', 'utf8').match(/bootstrap', \{ pin: '(\d{4})'/)?.[1]; assert(pin);
    await page.getByLabel('PIN', { exact: true }).fill(pin); await button('Sign in').click();
  }
  await button('Service').waitFor();
  const ready = await data('/api/pos/readiness'); assert(ready.settings.receiptFooter.includes('Demonstration receipt'));
  assert.equal((await data('/api/pos/bar/state')).tabs.filter(t => t.value.status === 'open').length, 0);
  await page.locator('.bar-drink').filter({ hasText: 'House Lager' }).click();
  await page.locator('.bar-lines').getByText('House Lager', { exact: true }).waitFor();
  let tab = (await data('/api/pos/bar/state')).tabs.find(t => t.value.status === 'open');
  assert.equal(tab.value.items.length, 1); assert.equal(tab.value.items[0].priceCents, 600);
  await button('Name bill').click(); await page.getByLabel('Bill name', { exact: true }).fill('Michael · patio');
  await button('Save bill name').click();
  await page.getByRole('dialog', { name: 'Name bill' }).waitFor({ state: 'detached' });
  await button('Add Bottled Water · $3.00').click();
  await page.locator('.bar-lines').getByText('Bottled Water', { exact: true }).waitFor();
  await page.locator('.bar-drink').filter({ hasText: 'Club Burger' }).click();
  const dialog = page.getByRole('dialog', { name: 'Club Burger', exact: true });
  await dialog.getByLabel('Quantity', { exact: true }).selectOption('2');
  await dialog.getByRole('radio', { name: /Side salad/ }).check();
  await dialog.getByRole('checkbox', { name: /House Lager/ }).check();
  await dialog.getByLabel('Preparation note', { exact: true }).fill('No onions');
  await dialog.getByRole('button', { name: 'Add to bill · $42.00', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.reload(); await button('Name bill').waitFor();
  tab = (await data('/api/pos/bar/state')).tabs.find(t => t.id === tab.id);
  assert.equal(tab.value.items.length, 5);
  assert.equal(tab.value.checks[0].name, 'Michael · patio');
  assert.equal(tab.value.checks[0].subtotalCents, 5100);
  assert.equal(tab.value.checks[0].taxCents, 510);
  assert.equal(tab.value.checks[0].orderId, null);
  await page.getByRole('heading', { name: 'Michael · patio', exact: true }).waitFor();
  await page.getByLabel('Find tab', { exact: true }).fill('Michael');
  assert.equal(await page.locator('.bar-tab').count(), 1);
  await page.getByLabel('Find tab', { exact: true }).fill('');
  assert.deepEqual(tab.value.items.filter(i => i.name === 'Club Burger').map(i => i.modifiers), [['Side: Side salad', 'Note: No onions'], ['Side: Side salad', 'Note: No onions']]);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: output + '/named-bill-landscape.png', fullPage: true });
  await page.setViewportSize({ width: 820, height: 1180 }); await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: output + '/named-bill-portrait.png', fullPage: true });
  await button('Manage').click(); await button('Cancel unpaid tab').click();
  await page.getByLabel('Reason', { exact: true }).fill('Disposable Add acceptance complete'); await button('Cancel tab').click();
  await page.getByRole('dialog', { name: 'Cancel unpaid tab', exact: true }).waitFor({ state: 'detached' });
  assert.equal((await data('/api/pos/bar/state')).tabs.find(t => t.id === tab.id).value.status, 'canceled');
  assert.deepEqual(errors, []);
  const result = { checkedAt: new Date().toISOString(), environment: 'Disposable practice only', firstItemCreatesTab: true,
    extrasSavedAtomically: true, billNamePersists: true, reloadPreservesFiveItems: true, subtotalCents: 5100, taxCents: 510,
    noPaymentOrKitchenSend: true, testTabCanceled: true, pageErrors: errors };
  writeFileSync(output + '/result.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} catch (error) { await page.screenshot({ path: output + '/failure.png', fullPage: true }); console.error(error); process.exitCode = 1; }
finally { await browser.close(); }
