/** Import reviewed photo-derived items through the authenticated venue API. Existing items are preserved. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const base = process.env.ONECLUB_IMPORT_URL || 'http://127.0.0.1:8480';
const origin = process.env.ONECLUB_IMPORT_ORIGIN;
const pinFile = process.env.ONECLUB_IMPORT_PIN_FILE;
if (!origin || !pinFile) throw new Error('Set ONECLUB_IMPORT_ORIGIN and ONECLUB_IMPORT_PIN_FILE for this venue.');
const path = process.env.ONECLUB_MENU_FILE || 'docs/bar-one/photo-menu-2026-09-06.json';
const raw = readFileSync(path, 'utf8');
const plan = JSON.parse(raw);
const digest = createHash('sha256').update(raw).digest('hex');
let cookie = '';
async function request(route, body, key) {
 const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
  origin, 'content-type': 'application/json', 'x-mags-csrf': '1', ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key } : {}),
 }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 const session = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
 if (session) cookie = session;
 const value = await response.json();
 if (!response.ok) throw new Error(`${route}: ${response.status} ${value.error?.message || 'Request failed'}`);
 return value.data;
}
const access = await request('/api/pos/auth/operators');
const operators = access.operators.filter(value => value.pinConfigured);
if (operators.length !== 1) throw new Error('Select an exact operator before importing into a venue with multiple PIN users.');
await request('/api/pos/auth/session', { userId: operators[0].id, pin: readFileSync(pinFile, 'utf8').trim() });
const before = await request('/api/pos/bar/state');
const seen = new Set(before.menu.map(row => `${row.value.category.toLowerCase()}\n${row.value.name.toLowerCase()}`));
const receipt = { importedAt: new Date().toISOString(), origin, source: path, sourceSha256: digest, added: [], preserved: [] };
for (const [index, entry] of plan.items.entries()) {
 const key = `${entry.menu.category.toLowerCase()}\n${entry.menu.name.toLowerCase()}`;
 if (seen.has(key)) { receipt.preserved.push(entry.menu.name); continue; }
 const result = await request('/api/pos/bar/menu', entry.menu, `photo-menu:${digest}:${index}`);
 seen.add(key); receipt.added.push({ id: result.id, name: result.value.name, priceCents: result.value.priceCents });
}
const setup = await request('/api/pos/bar/setup');
if (!setup) await request('/api/pos/bar/setup', { expectedVersion: 0, venueName: 'Bar One · ONE Club', processorName: '', devices: [
 {id:'bar-ipad',name:'Bar register',kind:'ipad',model:'iPad (A16) · iPadOS 26.6.1',connection:'network',access:'available'},
 {id:'bar-reader',name:'Card reader — pending connection',kind:'reader',model:'',connection:'unknown',access:'pending'},
 {id:'kitchen-printer',name:'Kitchen printer — pending connection',kind:'printer',model:'',connection:'unknown',access:'pending'},
 {id:'receipt-printer',name:'Receipt printer — pending connection',kind:'printer',model:'',connection:'unknown',access:'pending'},
 {id:'bar-drawer',name:'Cash drawer — pending connection',kind:'drawer',model:'',connection:'unknown',access:'pending'},
]},`photo-setup:${digest}`);
const after = await request('/api/pos/bar/state');
receipt.totalMenuItems = after.menu.length;
receipt.pricedItems = after.menu.filter(row => row.value.priceCents !== null).length;
receipt.pendingPrices = after.menu.filter(row => row.value.priceCents === null).map(row => row.value.name);
receipt.readiness = await request('/api/pos/readiness');
writeFileSync(process.env.ONECLUB_IMPORT_RECEIPT || '.storage/bar-one-venue/photo-menu-import.json', JSON.stringify(receipt,null,2)+'\n', { mode: 0o600 });
console.log(JSON.stringify({ added:receipt.added.length,preserved:receipt.preserved.length,total:receipt.totalMenuItems,priced:receipt.pricedItems,pendingPrices:receipt.pendingPrices.length }));
