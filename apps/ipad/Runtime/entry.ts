import { Buffer } from 'buffer';
import { createApp } from '../../api/src/app';
import { createNativeDatabase, native } from './database';
import { assertStorageKey } from '@blacklabel/files';

const originalFetch = globalThis.fetch.bind(globalThis);
const db = createNativeDatabase();
let cookie = '';
let tenantId = '';
let app: Awaited<ReturnType<typeof createApp>>['app'];
// This Promise is installed before any UI code executes. All business API
// requests go to the in-process app. There is no remote-server fallback.
const ready = (async () => {
  const state = await native({ action: 'open' });
  cookie = state.cookie || '';
  const tenants = await db.selectFrom('tenants').select('id').execute();
  if (tenants.length !== 1) throw new Error('The transferred register must contain exactly one venue.');
  tenantId = tenants[0].id;
  const storage = {
    kind: 'ipad',
    async put(key: string, data: Uint8Array) { assertStorageKey(key); await native({ action: 'filePut', key, data: Buffer.from(data).toString('base64') }); },
    async get(key: string) { assertStorageKey(key); return Buffer.from(await native({ action: 'fileGet', key }), 'base64'); },
    async exists(key: string) { assertStorageKey(key); return await native({ action: 'fileExists', key }); },
    async delete(key: string) { assertStorageKey(key); await native({ action: 'fileDelete', key }); },
  };
  const platform = await createApp({ db, posNetworkMode: true, includeCheckoutSimulator: false,
    adminMasterKey: Buffer.from(state.masterKey, 'base64'), storage,
    version: 'Bar One iPad 1.0 (12)',
    posProcessorStatus: async () => ({ connected: false, code: 'venue_processor_access_required', readers: [] }),
    backupProvider: {
      create: async () => native({ action: 'backup' }),
      restoreToTemp: async path => native({ action: 'backupRestore', path }),
      integrityCheck: async path => native({ action: 'backupCheck', path }),
      cleanupTemp: async path => { await native({ action: 'backupCleanup', path }); },
    },
  });
  app = platform.app;
  (globalThis as any).barOneLocal = { ready: true, storage: 'iPad' };
})();
ready.catch(error => {
  document.getElementById('view-root')!.textContent = `Register recovery required: ${error.message}`;
  native({ action: 'runtimeError', message: String(error.message) }).catch(() => {});
});
globalThis.fetch = async (input: any, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
  if (url.host !== location.host && url.origin !== 'https://barone.local') throw new Error('External POS API address rejected');
  await ready;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('x-tenant-id', tenantId);
  headers.set('origin', 'https://barone.local');
  headers.set('host', 'barone.local');
  if (cookie) headers.set('cookie', cookie);
  const request = new Request('https://barone.local' + url.pathname + url.search, { ...init, headers });
  (request as any).barOneSession = { mags_pos_session: cookie.replace(/^mags_pos_session=/, '') || undefined };
  const response = await app.fetch(request);
  const update = (request as any).barOneSessionUpdate;
  if (update?.name === 'mags_pos_session') {
    cookie = update.value ? `mags_pos_session=${update.value}` : '';
    await native({ action: 'session', cookie });
  }
  return response;
};
// randomUUID is missing in some custom-scheme WebKit secure-context checks.
if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => {
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}});
