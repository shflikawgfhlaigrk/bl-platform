/**
 * Process-wide serialization for mutations against one physical cash session.
 *
 * Black Label Platform runs one local API owner per database. A shared keyed
 * queue makes the drawer-close decision and POS cash pay/refund mutations one
 * critical section: whichever starts first finishes, and the loser then
 * re-checks the durable drawer status/facts before proceeding.
 */
const cashSessionTails = new Map<string, Promise<void>>();

function cashSessionKey(tenantId: string, cashSessionId: string): string {
  return JSON.stringify([tenantId, cashSessionId]);
}

export async function withPosCashSessionLock<T>(
  tenantId: string,
  cashSessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = cashSessionKey(tenantId, cashSessionId);
  const prior = cashSessionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => gate);
  cashSessionTails.set(key, tail);

  await prior.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (cashSessionTails.get(key) === tail) cashSessionTails.delete(key);
  }
}

