import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { serve } from '@hono/node-server';
import { asCoreDb, createTenant, listTenants } from '@blacklabel/core';
import { createDb, runMigrations, type Kysely } from '@blacklabel/db';
import { LocalDiskStorageProvider } from '@blacklabel/files';
import { GoogleCalendarProvider, createSchedulingContext, runReminderQueue, type SchedulingDatabase } from '@blacklabel/scheduling';
import { businessReminderDelivery } from '../../api/src/business-reminders';
import { businessReviewProvider } from '../../api/src/business-reviews';
import { processDueReminders, type ReviewsDatabase, type ReviewProvider } from '@blacklabel/reviews';
import { generateDueInvoices, type BillingDatabase } from '@blacklabel/billing';
import { ResendEmailProvider, type MessagingDatabase } from '@blacklabel/messaging';
import { createApp, type PlatformDatabase } from '../../api/src/app';
import { acquireStartupLock } from '../../api/src/startup-lock';
import { SqliteBackupProvider, makeCountProbe } from '../../api/src/admin-wiring';
import { createBusinessApp, type BusinessSettings } from './app';
import { backupBusiness, restoreBusiness } from './recovery';
import { businessTransport, businessRequest } from './transport';
import { businessEmployeeFiles } from '../../api/src/business-wiring';
import { businessIntegrationMigrations, customerRecordIntegration } from './integrations';

const dataRoot = path.resolve(process.env.BLACKLABEL_BUSINESS_DATA ?? path.join(os.homedir(), '.blacklabel-business/data'));
await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
if (process.argv[2] === 'restore') {
  if (!process.argv[3]) throw new Error('Provide the BlackLabel backup archive.');
  console.log(JSON.stringify(await restoreBusiness(path.resolve(process.argv[3]), dataRoot))); process.exit(0);
}
const databasePath = path.join(dataRoot, 'platform.db');
// Held for the lifetime of this customer runtime, including background work.
const releaseLock = await acquireStartupLock(databasePath, { timeoutMs: 1000 });
if (process.argv[2] === 'backup') {
  try { console.log(JSON.stringify(await backupBusiness(dataRoot))); }
  finally { await releaseLock(); }
  process.exit(0);
}
const transport = await businessTransport(process.env);
const packaged = await fs.readFile(new URL('./manifest.json', import.meta.url), 'utf8').then(JSON.parse).catch((error) => {
  if (error.code !== 'ENOENT') throw error; return { version: '1.0.0', buildId: 'source' };
});
const secret = async (name: string, bytes: number) => {
  const file = path.join(dataRoot, name);
  try { await fs.writeFile(file, randomBytes(bytes).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return (await fs.readFile(file, 'utf8')).trim();
};
const masterKey = Buffer.from(await secret('admin.key', 32), 'base64url');
const accessToken = await secret('access.token', 32);
const settingsPath = path.join(dataRoot, 'settings.enc');
let settings: BusinessSettings;
try {
  const sealed = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  settings = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.body, 'base64')), decipher.final()]).toString());
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Company settings could not be verified. Restore a verified backup.'); settings = { companyName: 'Your company' }; }
const saveSettings = async (next: BusinessSettings) => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
  const temp = `${settingsPath}.pending`;
  await fs.writeFile(temp, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }), { mode: 0o600 });
  await fs.rename(temp, settingsPath); settings = next;
};
await saveSettings({ ...settings, publicOrigin: transport.publicOrigin });
const db = createDb<PlatformDatabase>(databasePath);
let tenantId = '';
let app: ReturnType<typeof createBusinessApp>;
const email = new ResendEmailProvider({ connection: async (id) => id === tenantId ? settings.email : undefined });
const calendarSync = new GoogleCalendarProvider({ connection: async id => id === tenantId ? settings.googleCalendar : undefined });
const storage = new LocalDiskStorageProvider(path.join(dataRoot, 'files'));
const reviews: ReviewProvider = {
  key: 'business_email',
  listCompletedJobs: tenant => businessReviewProvider(db, platform.events, { providers: { email } }, () => settings.publicOrigin).listCompletedJobs!(tenant),
  getDeliveryStatus: context => businessReviewProvider(db, platform.events, { providers: { email } }, () => settings.publicOrigin).getDeliveryStatus!(context),
  sendReviewRequest: context => businessReviewProvider(db, platform.events, { providers: { email } }, () => settings.publicOrigin).sendReviewRequest(context),
  sendReminder: context => businessReviewProvider(db, platform.events, { providers: { email } }, () => settings.publicOrigin).sendReminder(context),
  syncExternalReviews: async () => { throw new Error('External review import is not connected.'); },
};
const platform = await createApp({ db, storage, adminMasterKey: masterKey,
  businessPortals: true, browserSessionUser: async (request, tenant) => tenant === tenantId ? app?.resolveOwnerRequest(request) : undefined,
  includeCheckoutSimulator: false, scheduling: { calendarSync }, messaging: { providers: { email } }, reviewProvider: reviews, backupProvider: new SqliteBackupProvider(databasePath, { key: masterKey, staticRoots: [process.env.BLACKLABEL_BUSINESS_WEB ?? fileURLToPath(new URL('./public/', import.meta.url))] }),
  countProbe: makeCountProbe(db as any), dbPath: databasePath, storageDir: dataRoot, version: '1.0.0' });
const tenants = await listTenants(asCoreDb(db));
if (tenants.length > 1) throw new Error('Use a dedicated BlackLabel business data directory for this customer installation.');
tenantId = tenants[0]?.id ?? (await createTenant(asCoreDb(db), { name: settings.companyName })).id;
const owner = await platform.seedTenant(tenantId, { ownerName: 'Company owner' });
await runMigrations(db, businessIntegrationMigrations);
await fs.writeFile(path.join(dataRoot, 'identity.json'), JSON.stringify({ brand: 'BlackLabel', tenantId, ownerUserId: owner.ownerUserId }), { mode: 0o600 });
const assets = process.env.BLACKLABEL_BUSINESS_WEB ?? fileURLToPath(new URL('./public/', import.meta.url));
app = createBusinessApp({ platform, tenantId, ownerUserId: owner.ownerUserId, accessToken, settings: async () => settings,
  saveSettings, asset: (name) => fs.readFile(path.join(assets, name)), backup: () => backupBusiness(dataRoot),
  version: packaged.version, buildId: packaged.buildId, installationId: tenantId, employeeFiles: businessEmployeeFiles(db, platform.events, storage),
  purchasedModules: packaged.purchasedModules ?? [], customerRecords: customerRecordIntegration(db, platform.events, tenantId, owner.ownerUserId) });
// One queue covers API requests, scheduled retries, and a consistent database+vault backup.
let tail: Promise<unknown> = Promise.resolve();
const serial = <T>(work: () => Promise<T>) => { const result = tail.then(work); tail = result.catch(() => {}); return result; };
const { host, port } = transport;
const server = serve({ hostname: host, port, ...(transport.tls ? { createServer: createHttpsServer, serverOptions: transport.tls } : {}),
  fetch: (request) => businessRequest(request, transport, (bounded) => serial(async () => app.fetch(bounded)))
}, (info) => console.log(JSON.stringify({ brand: 'BlackLabel', version: packaged.version, buildId: packaged.buildId,
  url: transport.publicOrigin ?? `http://${host.includes(':') ? `[${host}]` : host}:${info.port}`, tenantId, ready: true })));
const reminderContext = createSchedulingContext({ db: db as unknown as Kysely<SchedulingDatabase>, events: platform.events, reminderDelivery: businessReminderDelivery(db as unknown as Kysely<MessagingDatabase>, platform.events, { providers: { email } }) });
const timer = setInterval(() => { serial(async () => {
  await platform.engine.runPending({ tenantId });
  await generateDueInvoices({ db: db as unknown as Kysely<BillingDatabase>, events: platform.events }, tenantId);
  if (settings.email?.apiKey) await runReminderQueue(reminderContext, tenantId);
  if (settings.email?.apiKey && settings.publicOrigin) await processDueReminders(db as unknown as Kysely<ReviewsDatabase>, tenantId, 'system', { provider: reviews });
}).catch(() => console.error('Scheduled work needs review in the execution log.')); }, 15000);
timer.unref();
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; clearInterval(timer);
  await new Promise<void>((resolve) => server.close(() => resolve())); await tail;
  platform.detachEngine(); await db.destroy(); await releaseLock(); process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('message', (message) => { if ((message as { type?: string })?.type === 'blacklabel:shutdown') void shutdown(); });
