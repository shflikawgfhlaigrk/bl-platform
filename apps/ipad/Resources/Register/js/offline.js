/**
 * Offline mutation queue — browser side. Persists the pure queue reducer's
 * items in IndexedDB and replays them FIFO on reconnect. The decision logic
 * (what's queued/failed/conflict, sync status) lives in ../../src/queue.mjs so
 * it is unit-tested; this file is just persistence + the fetch loop.
 *
 * Every queued mutation carries an idempotencyKey the APIs already honour, so
 * a replay is safe even if the first attempt actually reached the server. A
 * 409 on replay is a genuine conflict → kept in a review list, never dropped.
 */
import * as Q from '../../src/queue.mjs';

const DB_NAME = 'mags-os';
const STORE = 'mutation-queue';
let idb = null;
let state = Q.initialState();
let listeners = new Set();
let sender = null; // injected raw fetch: (mutation) => Promise<{ok, status, body}>
let draining = false;

function openIdb() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function tx(mode) {
  return idb.transaction(STORE, mode).objectStore(STORE);
}

async function persistItem(item) {
  if (!idb) return;
  await new Promise((res) => {
    const r = tx('readwrite').put(item);
    r.onsuccess = res;
    r.onerror = res;
  });
}
async function deleteItem(id) {
  if (!idb) return;
  await new Promise((res) => {
    const r = tx('readwrite').delete(id);
    r.onsuccess = res;
    r.onerror = res;
  });
}
async function loadAll() {
  if (!idb) return [];
  return new Promise((res) => {
    const r = tx('readonly').getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => res([]);
  });
}

function emit() {
  const snapshot = {
    status: Q.syncStatus(state),
    pending: Q.pendingCount(state),
    counts: Q.counts(state),
    conflicts: Q.conflicts(state),
    items: state.items.slice(),
  };
  listeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch {
      /* isolate listener errors */
    }
  });
}

/** Subscribe to queue snapshots. Returns an unsubscribe. */
export function onQueueChange(fn) {
  listeners.add(fn);
  fn(currentSnapshot());
  return () => listeners.delete(fn);
}

export function currentSnapshot() {
  return {
    status: Q.syncStatus(state),
    pending: Q.pendingCount(state),
    counts: Q.counts(state),
    conflicts: Q.conflicts(state),
    items: state.items.slice(),
  };
}

/**
 * Initialize. `sendRaw(mutation)` must resolve `{ ok, status, body }` and
 * REJECT only on a true network failure (so we can distinguish 409 from offline).
 */
export async function initOfflineQueue(sendRaw) {
  sender = sendRaw;
  idb = await openIdb();
  const items = await loadAll();
  // Rebuild reducer state; any 'inflight' at load time was interrupted → requeue.
  state = { items: items.map((it) => (it.state === 'inflight' ? { ...it, state: 'queued' } : it)) };
  emit();
  window.addEventListener('online', () => {
    setOfflineBadge(false);
    drain();
  });
  window.addEventListener('offline', () => setOfflineBadge(true));
  setOfflineBadge(!navigator.onLine);
  if (navigator.onLine || document.body.dataset.nativePos === 'true') drain();
}

function setOfflineBadge(off) {
  const b = document.getElementById('offline-badge');
  if (b) b.hidden = !off || document.body.dataset.nativePos === 'true';
}

/** Enqueue a mutation for (eventual) delivery. Persists immediately. */
export async function queueMutation(m) {
  state = Q.enqueue(state, m);
  await persistItem(Q.find(state, m.id));
  emit();
  if (navigator.onLine || document.body.dataset.nativePos === 'true') drain();
  return m.id;
}

/** Drain the queue FIFO. One in flight at a time keeps replay ordering honest. */
export async function drain() {
  if (draining || !sender) return;
  draining = true;
  try {
    let next;
    while ((next = Q.nextQueued(state))) {
      state = Q.markInflight(state, next.id);
      await persistItem(Q.find(state, next.id));
      emit();
      let result;
      try {
        result = await sender(next);
      } catch {
        // Network failure — stop; leave as failed and try again on reconnect.
        state = Q.markFailure(state, next.id, 'network unavailable');
        await persistItem(Q.find(state, next.id));
        emit();
        break;
      }
      if (result.ok) {
        state = Q.markSuccess(state, next.id);
        await deleteItem(next.id);
      } else if (result.status === 409) {
        state = Q.markConflict(state, next.id, result.body);
        await persistItem(Q.find(state, next.id));
      } else {
        state = Q.markFailure(state, next.id, describe(result));
        await persistItem(Q.find(state, next.id));
      }
      emit();
    }
  } finally {
    draining = false;
  }
}

function describe(result) {
  const b = result.body;
  if (b && b.error && b.error.message) return b.error.message;
  return `server returned ${result.status}`;
}

/** Retry all failed items (the sync indicator's retry button). */
export async function retryFailed() {
  state = Q.retryAll(state);
  for (const it of state.items) await persistItem(it);
  emit();
  drain();
}

/** Re-queue a single reviewed conflict item. */
export async function retryItem(id) {
  state = Q.retry(state, id);
  const it = Q.find(state, id);
  if (it) await persistItem(it);
  emit();
  drain();
}

/** Discard a conflict item the owner has decided to abandon (audited server-side already). */
export async function discardItem(id) {
  state = Q.markSuccess(state, id); // remove from queue
  await deleteItem(id);
  emit();
}
