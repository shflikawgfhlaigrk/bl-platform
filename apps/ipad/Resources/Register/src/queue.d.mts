export interface QueueItem {
  id: string;
  url: string;
  method: string;
  body: unknown;
  idempotencyKey: string;
  queuedAt: string;
  actorId: string | null;
  state: 'queued' | 'inflight' | 'failed' | 'conflict';
  attempts: number;
  error: string | null;
  conflict: unknown;
}
export interface QueueState {
  items: QueueItem[];
}
export interface Mutation {
  id: string;
  url: string;
  method?: string;
  body?: unknown;
  idempotencyKey: string;
  queuedAt: string;
  actorId?: string | null;
}
export function initialState(): QueueState;
export function enqueue(state: QueueState, m: Mutation): QueueState;
export function nextQueued(state: QueueState): QueueItem | null;
export function markInflight(state: QueueState, id: string): QueueState;
export function markSuccess(state: QueueState, id: string): QueueState;
export function markFailure(state: QueueState, id: string, error?: string): QueueState;
export function markConflict(state: QueueState, id: string, serverBody?: unknown): QueueState;
export function retry(state: QueueState, id: string): QueueState;
export function retryAll(state: QueueState): QueueState;
export function find(state: QueueState, id: string): QueueItem | null;
export function conflicts(state: QueueState): QueueItem[];
export function counts(state: QueueState): { queued: number; inflight: number; failed: number; conflict: number };
export function syncStatus(state: QueueState): 'synced' | 'queued' | 'failed';
export function pendingCount(state: QueueState): number;
