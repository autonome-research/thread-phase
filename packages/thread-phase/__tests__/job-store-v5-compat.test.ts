import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';

let dir: string;
let store: SqliteJobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thread-phase-v5-api-'));
  store = new SqliteJobStore(join(dir, 'jobs.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('documented v5.0.0 JobStore compatibility', () => {
  it('returns boolean CAS results and guards owner-aware terminal transitions', async () => {
    const id = await store.createJob('owned', null);

    await expect(store.setRunning(id, { ownerId: 'owner-a' })).resolves.toBe(true);
    await expect(store.setRunning(id, { ownerId: 'owner-b' })).resolves.toBe(false);
    await expect(store.setCompleted(id, { wrong: true }, 'owner-b')).resolves.toBe(false);
    await expect(store.setCompleted(id, { ok: true }, 'owner-a')).resolves.toBe(true);
    await expect(store.setFailed(id, 'late', 'owner-a')).resolves.toBe(false);

    expect(await store.getJob(id)).toMatchObject({
      status: 'COMPLETED',
      result: { ok: true },
      error: null,
      ownerId: 'owner-a',
    });
  });

  it('exposes required cancellation, abandonment, heartbeat, and atomic finalization methods', async () => {
    const cancelled = await store.createJob('cancelled', null);
    await expect(store.setRunning(cancelled, { ownerId: 'owner' })).resolves.toBe(true);
    await expect(store.enableHeartbeat(cancelled, 'foreign')).resolves.toBe(false);
    await expect(store.enableHeartbeat(cancelled, 'owner')).resolves.toBe(true);
    await expect(store.setCancelled(cancelled, 'stop', 'foreign')).resolves.toBe(false);
    await expect(store.setCancelled(cancelled, 'stop', 'owner')).resolves.toBe(true);

    const finalized = await store.createJob('finalized', null);
    await store.setRunning(finalized, { ownerId: 'owner' });
    await expect(store.finalizeJob(finalized, {
      status: 'FAILED',
      error: 'boom',
      event: { type: 'error', message: 'boom' },
      ownerId: 'owner',
    })).resolves.toMatchObject({ eventType: 'error', jobId: finalized });
    await expect(store.finalizeJob(finalized, {
      status: 'COMPLETED',
      event: { type: 'done' },
      ownerId: 'owner',
    })).resolves.toBeNull();
    expect(await store.getEvents(finalized)).toHaveLength(1);
  });
});
