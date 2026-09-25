/**
 * Cross-process startup fence for one file-backed platform database.
 *
 * The shared migration runner intentionally stays module-agnostic. The local
 * API therefore serializes the whole boot sequence (migrations, startup
 * reconciliation, and tenant seeding) with an atomic directory next to the
 * database. Owner files use unique names so stale-owner cleanup can never
 * unlink a newly acquired lock.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';

interface StartupLockOwner {
  token: string;
  pid: number;
  acquired_at: string;
  process_started_at: string;
  database_path: string;
}

export interface StartupLockOptions {
  /** Maximum time to wait for a live boot owner. Defaults to two minutes. */
  timeoutMs?: number;
  /** Poll interval while another process owns the fence. Defaults to 100ms. */
  pollMs?: number;
  /** Grace period for an empty or malformed lock directory. Defaults to 5s. */
  orphanGraceMs?: number;
}

export type ReleaseStartupLock = () => Promise<void>;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_ORPHAN_GRACE_MS = 5_000;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that a process owns the PID; ESRCH proves it does not.
    return isNodeError(error, 'EPERM');
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startupLockPath(databasePath: string): string {
  return `${path.resolve(databasePath)}.startup-lock`;
}

async function removeDeadOwners(lockPath: string, orphanGraceMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }

  if (entries.length === 0) {
    const lockStat = await stat(lockPath).catch(() => null);
    if (lockStat && Date.now() - lockStat.mtimeMs >= orphanGraceMs) {
      await rmdir(lockPath).catch((error) => {
        if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY')) throw error;
      });
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const ownerPath = path.join(lockPath, entry);
    let owner: StartupLockOwner | null = null;
    try {
      owner = JSON.parse(await readFile(ownerPath, 'utf8')) as StartupLockOwner;
    } catch {
      const ownerStat = await stat(ownerPath).catch(() => null);
      if (ownerStat && Date.now() - ownerStat.mtimeMs < orphanGraceMs) continue;
    }

    if (owner && processIsAlive(owner.pid)) continue;

    // The filename is unique to the observed owner. If another process has
    // already replaced the lock directory, this path cannot name its owner.
    await unlink(ownerPath).catch((error) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
  }

  await rmdir(lockPath).catch((error) => {
    if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY')) throw error;
  });
}

/** Acquire the database-scoped startup fence and return an ownership-safe release. */
export async function acquireStartupLock(
  databasePath: string,
  options: StartupLockOptions = {},
): Promise<ReleaseStartupLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('timeoutMs must be >= 0');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('pollMs must be > 0');
  if (!Number.isFinite(orphanGraceMs) || orphanGraceMs < 0) {
    throw new Error('orphanGraceMs must be >= 0');
  }

  const databaseAbsolutePath = path.resolve(databasePath);
  const lockPath = startupLockPath(databaseAbsolutePath);
  const token = randomUUID();
  const ownerPath = path.join(lockPath, `${process.pid}-${token}.json`);
  const startedAt = Date.now();

  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner: StartupLockOwner = {
        token,
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        process_started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        database_path: databaseAbsolutePath,
      };
      try {
        await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw error;
      }

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(ownerPath).catch((error) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        });
        await rmdir(lockPath).catch((error) => {
          if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY')) throw error;
        });
      };
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }

    await removeDeadOwners(lockPath, orphanGraceMs);
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Timed out waiting for database startup lock at ${lockPath}; another platform process may still be booting.`,
      );
    }
    await pause(pollMs);
  }
}

/** Run one boot sequence while holding the database-scoped startup fence. */
export async function withStartupLock<T>(
  databasePath: string,
  task: () => Promise<T>,
  options: StartupLockOptions = {},
): Promise<T> {
  const release = await acquireStartupLock(databasePath, options);
  try {
    return await task();
  } finally {
    await release();
  }
}
