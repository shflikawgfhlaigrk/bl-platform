/**
 * Offline mutation queue — pure reducer. The browser layer (js/offline.js)
 * persists this state in IndexedDB and does the actual fetch()ing; ALL the
 * decision logic lives here so it is deterministic and unit-testable.
 *
 * A mutation queued while offline is replayed FIFO on reconnect. Movements,
 * count-lines and scan posts carry an idempotencyKey the APIs already honour,
 * so a replay is safe even if the original request had in fact reached the
 * server. A server 409 on replay is a real conflict: the item is moved to a
 * review state and NEVER silently dropped.
 *
 * Item states:
 *   queued   — waiting to be sent (or re-queued after a retry)
 *   inflight — currently being sent
 *   failed   — transient failure (network/5xx); retryable
 *   conflict — server returned 409 on replay; needs human review
 * A successful send removes the item entirely.
 */

/** @returns {{ items: Array }} */
export function initialState() {
  return { items: [] };
}

/**
 * @param {{items:Array}} state
 * @param {{ id:string, url:string, method:string, body?:any, idempotencyKey:string, queuedAt:string, actorId?:string|null }} m
 */
export function enqueue(state, m) {
  if (!m.id) throw new Error('enqueue: id required');
  if (!m.idempotencyKey) throw new Error('enqueue: idempotencyKey required');
  const item = {
    id: m.id,
    url: m.url,
    method: m.method || 'POST',
    body: m.body ?? null,
    idempotencyKey: m.idempotencyKey,
    queuedAt: m.queuedAt,
    actorId: m.actorId ?? null,
    state: 'queued',
    attempts: 0,
    error: null,
    conflict: null,
  };
  return { ...state, items: [...state.items, item] };
}

function patch(state, id, fields) {
  return {
    ...state,
    items: state.items.map((it) => (it.id === id ? { ...it, ...fields } : it)),
  };
}

/** The next item eligible to send (FIFO over queued items). */
export function nextQueued(state) {
  return state.items.find((it) => it.state === 'queued') ?? null;
}

export function markInflight(state, id) {
  return patch(state, id, { state: 'inflight', attempts: (find(state, id)?.attempts ?? 0) + 1 });
}

/** Success — drop the item. */
export function markSuccess(state, id) {
  return { ...state, items: state.items.filter((it) => it.id !== id) };
}

/** Transient failure — becomes retryable 'failed'. */
export function markFailure(state, id, error) {
  return patch(state, id, { state: 'failed', error: error ?? 'send failed' });
}

/** 409 on replay — a real conflict; kept for review, never dropped. */
export function markConflict(state, id, serverBody) {
  return patch(state, id, { state: 'conflict', conflict: serverBody ?? null });
}

/** Re-queue one failed/conflict item for another replay pass. */
export function retry(state, id) {
  const it = find(state, id);
  if (!it || (it.state !== 'failed' && it.state !== 'conflict')) return state;
  return patch(state, id, { state: 'queued', error: null });
}

/** Re-queue every failed item (the sync-status "retry" button). */
export function retryAll(state) {
  return {
    ...state,
    items: state.items.map((it) =>
      it.state === 'failed' ? { ...it, state: 'queued', error: null } : it,
    ),
  };
}

export function find(state, id) {
  return state.items.find((it) => it.id === id) ?? null;
}

/** Items in the conflict-review list. */
export function conflicts(state) {
  return state.items.filter((it) => it.state === 'conflict');
}

/** Counts by state, for the indicator. */
export function counts(state) {
  const c = { queued: 0, inflight: 0, failed: 0, conflict: 0 };
  for (const it of state.items) c[it.state] = (c[it.state] ?? 0) + 1;
  return c;
}

/**
 * Aggregate sync indicator:
 *   'synced' — nothing pending
 *   'queued' — work waiting/inflight, nothing wrong (amber)
 *   'failed' — at least one failed or conflict item (red, needs retry/review)
 */
export function syncStatus(state) {
  const c = counts(state);
  if (c.failed > 0 || c.conflict > 0) return 'failed';
  if (c.queued > 0 || c.inflight > 0) return 'queued';
  return 'synced';
}

/** Total number of not-yet-delivered items (for the "N queued" badge). */
export function pendingCount(state) {
  return state.items.length;
}
