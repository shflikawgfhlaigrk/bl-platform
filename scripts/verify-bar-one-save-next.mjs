/** Isolated UI acceptance: stable taps/scroll, persistent Save & next, failure retention. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs';
const origin = process.env.ONECLUB_ACCEPTANCE_ORIGIN;
if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw Error('Use an isolated loopback practice server.');
const output = '.storage/bar-one-save-next-acceptance'; mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 740 }, serviceWorkers: 'block' }); page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
const createdTabs = [];
const button = name => page.getByRole('button', { name, exact: true });
const state = async () => { const r = await page.request.get(origin + '/api/pos/bar/state'); assert(r.ok()); return (await r.json()).data; };
const tile = name => page.locator('.bar-drink').filter({ hasText: name });
const rename = async name => { await button('Name bill').click(); await page.getByLabel('Bill name', { exact: true }).fill(name); await button('Save bill name').click(); await page.getByRole('dialog', { name: 'Name bill' }).waitFor({ state: 'detached' }); };
const cancel = async () => { await button('Manage').click(); await button('Cancel unpaid tab').click(); await page.getByLabel('Reason', { exact: true }).fill('Disposable Save and next acceptance complete'); await button('Cancel tab').click(); await page.getByRole('dialog', { name: 'Cancel unpaid tab' }).waitFor({ state: 'detached' }); };
const bounds = async () => page.evaluate(() => {
  const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
  return { menu: box('.bar-menu'), categories: box('.bar-categories'), check: box('.bar-check'), footer: box('.bar-check-footer'), scroll: document.querySelector('.bar-tiles').scrollTop, pageScroll: scrollY, documentHeight: document.documentElement.scrollHeight, viewport: innerHeight };
});
const visibleFooter = async () => { const r = await button('Save & next').boundingBox(); assert(r && r.y >= 0 && r.y + r.height <= (await page.viewportSize()).height, 'Save & next must stay in the viewport'); };
try {
  await page.goto(origin + '/#/bar'); await page.locator('.preview-banner').waitFor();
  assert((await page.locator('.preview-banner').innerText()).includes('PRACTICE MODE'));
  if (await button('Sign in').isVisible()) {
    const pin = readFileSync('scripts/bar-ui-preview.ts', 'utf8').match(/bootstrap', \{ pin: '(\d{4})'/)?.[1]; assert(pin);
    await page.getByLabel('PIN', { exact: true }).fill(pin); await button('Sign in').click();
  }
  await button('Service').waitFor(); assert.equal((await state()).tabs.filter(t => t.value.status === 'open').length, 0);
  await tile('House Lager').click(); await button('Save & next').waitFor(); await rename('Saved guest one');
  const first = (await state()).tabs.find(t => t.value.status === 'open'); assert(first);
  createdTabs.push(first.id);
  await page.locator('.bar-tiles').evaluate(n => { n.scrollTop = 80; });
  await visibleFooter();
  const baseline = await bounds(); assert(baseline.documentHeight <= baseline.viewport + 1, 'The register must not scroll as a page');
  // Sample every displayed frame while a slow save is in progress, not only its final position.
  await page.route('**/api/pos/bar/tabs/*/commands', async route => { await new Promise(resolve => setTimeout(resolve, 500)); await route.continue(); });
  await page.evaluate(() => {
    window.barMotionSamples = []; window.barSampleMotion = true;
    const sample = () => {
      const menu = document.querySelector('.bar-menu'), footer = document.querySelector('.bar-check-footer');
      window.barMotionSamples.push({ menuY: menu.getBoundingClientRect().y, footerY: footer.getBoundingClientRect().y, scroll: document.querySelector('.bar-tiles').scrollTop, pageY: scrollY });
      if (window.barSampleMotion) requestAnimationFrame(sample);
    }; requestAnimationFrame(sample);
  });
  await tile('Old Fashioned').click();
  await page.locator('.bar-lines').getByText('Old Fashioned', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.bar-workspace').hasAttribute('aria-busy'));
  const samples = await page.evaluate(() => { window.barSampleMotion = false; return window.barMotionSamples; });
  assert(samples.length > 5);
  for (const sample of samples) {
    assert(Math.abs(sample.menuY - baseline.menu[1]) < 1, 'Menu jumped during save');
    assert(Math.abs(sample.footerY - baseline.footer[1]) < 1, 'Bill actions jumped during save');
    assert(Math.abs(sample.scroll - baseline.scroll) < 1, 'Menu scroll reset during save'); assert.equal(sample.pageY, 0);
  }
  await page.unroute('**/api/pos/bar/tabs/*/commands');
  await page.evaluate(() => { window.barStableMenu = document.querySelector('.bar-menu'); });
  await page.waitForResponse(r => r.url() === origin + '/api/pos/bar/state' && r.request().method() === 'GET');
  await page.waitForTimeout(150);
  assert(await page.evaluate(() => window.barStableMenu === document.querySelector('.bar-menu')), 'Unchanged polling replaced the menu');
  await button('Save & next').click(); await page.getByRole('heading', { name: 'Next guest', exact: true }).waitFor();
  await page.reload(); await page.getByRole('heading', { name: 'Next guest', exact: true }).waitFor();
  const persisted = (await state()).tabs.find(t => t.id === first.id); assert.equal(persisted.value.items.length, 2); assert.equal(persisted.value.checks[0].name, 'Saved guest one'); assert.equal(persisted.value.status, 'open');
  await tile('House Lager').click(); await rename('Saved guest two');
  const second = (await state()).tabs.find(t => t.value.status === 'open' && t.id !== first.id); assert(second); assert.equal(second.value.items.length, 1);
  createdTabs.push(second.id);
  await visibleFooter(); await page.screenshot({ path: output + '/landscape.png' });
  await page.setViewportSize({ width: 820, height: 1080 }); await visibleFooter();
  assert((await bounds()).documentHeight <= 1081); await page.screenshot({ path: output + '/portrait.png' });
  // Failed confirmation must keep the current guest selected and saved contents intact.
  await page.route('**/api/pos/bar/state', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Temporary verification outage' } }) }));
  const rejected = page.waitForResponse(r => r.url() === origin + '/api/pos/bar/state' && r.status() === 503);
  await button('Save & next').click(); await rejected; await page.waitForFunction(() => !document.querySelector('.bar-workspace').hasAttribute('aria-busy'));
  await page.getByRole('heading', { name: 'Saved guest two', exact: true }).waitFor();
  await page.unroute('**/api/pos/bar/state');
  await cancel(); await page.locator('.bar-tab').filter({ hasText: 'Saved guest one' }).click();
  await page.getByRole('heading', { name: 'Saved guest one', exact: true }).waitFor(); assert.equal((await state()).tabs.find(t => t.id === first.id).value.items.length, 2);
  await cancel(); assert.equal((await state()).tabs.filter(t => t.value.status === 'open').length, 0); assert.deepEqual(errors, []);
  const result = { checkedAt: new Date().toISOString(), environment: 'Disposable practice only', sampledFrames: samples.length, maxMenuMovement: Math.max(...samples.map(s => Math.abs(s.menuY - baseline.menu[1]))), maxFooterMovement: Math.max(...samples.map(s => Math.abs(s.footerY - baseline.footer[1]))), scrollPreserved: true, unchangedPollPreservesDOM: true, savedBillReopens: true, nextGuestSurvivesReload: true, nextItemCreatesSeparateTab: true, failedConfirmationRetainsGuest: true, landscapeAndPortraitFooterVisible: true, testTabsCanceled: true, actualServiceOrPaymentSent: false, pageErrors: errors };
  writeFileSync(output + '/result.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} catch (error) { await page.screenshot({ path: output + '/failure.png' }); console.error(error); process.exitCode = 1; }
finally {
  await page.unrouteAll({ behavior: 'wait' });
  for (const id of createdTabs) {
    const tab = (await state()).tabs.find(t => t.id === id);
    if (tab?.value.status === 'open') await page.request.post(origin + `/api/pos/bar/tabs/${id}/commands`, { headers: { origin, 'x-mags-csrf': '1', 'idempotency-key': crypto.randomUUID() }, data: { action: 'cancel', version: tab.version, reason: 'Disposable Save and next acceptance cleanup' } });
  }
  await browser.close();
}
