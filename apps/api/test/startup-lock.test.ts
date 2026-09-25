import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireStartupLock,
  startupLockPath,
  withStartupLock,
} from '../src/startup-lock';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryDatabasePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'blacklabel-startup-lock-'));
  cleanup.push(dir);
  return path.join(dir, 'platform.db');
}

describe('database startup lock', () => {
  it('serializes concurrent boot sequences and removes the fence afterward', async () => {
    const databasePath = await temporaryDatabasePath();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withStartupLock(databasePath, async () => {
      events.push('first:start');
      await firstMayFinish;
      events.push('first:end');
    }, { pollMs: 5, timeoutMs: 1_000 });

    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = withStartupLock(databasePath, async () => {
      events.push('second:start');
      events.push('second:end');
    }, { pollMs: 5, timeoutMs: 1_000 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    await expect(readdir(startupLockPath(databasePath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans a dead owner without touching a newly acquired owner token', async () => {
    const databasePath = await temporaryDatabasePath();
    const lockPath = startupLockPath(databasePath);
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, '2147483647-dead.json'), JSON.stringify({
      token: 'dead',
      pid: 2_147_483_647,
      acquired_at: new Date(0).toISOString(),
      process_started_at: new Date(0).toISOString(),
      database_path: path.resolve(databasePath),
    }));

    const release = await acquireStartupLock(databasePath, {
      pollMs: 5,
      timeoutMs: 1_000,
      orphanGraceMs: 0,
    });
    const entries = await readdir(lockPath);
    expect(entries).toHaveLength(1);
    const liveOwner = JSON.parse(await readFile(path.join(lockPath, entries[0]!), 'utf8')) as {
      pid: number;
      database_path: string;
    };
    expect(liveOwner).toMatchObject({ pid: process.pid, database_path: path.resolve(databasePath) });

    await release();
    await release();
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases the fence when boot throws', async () => {
    const databasePath = await temporaryDatabasePath();
    await expect(withStartupLock(databasePath, async () => {
      throw new Error('boot failed');
    })).rejects.toThrow('boot failed');

    const release = await acquireStartupLock(databasePath, { timeoutMs: 100 });
    await release();
  });
});
