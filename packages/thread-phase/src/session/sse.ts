/**
 * Server-Sent Events bridge for JobRunner live events plus JobStore replay.
 * Event ids are store cursors, allowing clients to resume with Last-Event-ID.
 */

import type { JobStore } from './job-store.js';
import type { JobRunner, LiveEvent } from './job-runner.js';

/** Minimal response shape. `once('drain')` and `off('close')` are required
 * so backpressure waits can be cancelled without leaking listeners. */
export interface SSEResponse {
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close', listener: () => void): void;
  off(event: 'close' | 'drain', listener: () => void): void;
  once(event: 'drain', listener: () => void): void;
}

export interface StreamToSSEOptions {
  runner: JobRunner;
  store: JobStore;
  jobId: string;
  res: SSEResponse;
  /** Replay events with id > afterId before draining buffered live events. */
  afterId?: number;
  /** SSE comment heartbeat interval. Default 25s; set 0 to disable. */
  heartbeatMs?: number;
  /** Store polling interval for terminal events emitted by other processes. Default 1s; set 0 to disable. */
  pollMs?: number;
}

const TERMINAL_EVENTS = new Set(['done', 'error', 'cancelled', 'abandoned']);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED']);

/** Pump a job's events until terminal state or client disconnect. */
export async function streamToSSE(options: StreamToSSEOptions): Promise<void> {
  const { runner, store, jobId, res, afterId = 0 } = options;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const pollMs = options.pollMs ?? 1_000;
  for (const method of ['off', 'once'] as const) {
    if (typeof res[method] !== 'function') {
      throw new TypeError(`SSEResponse must implement ${method}()`);
    }
  }
  for (const [label, value] of [['heartbeatMs', heartbeatMs], ['pollMs', pollMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer`);
    }
  }
  const channel = `job:${jobId}`;

  let closed = false;
  let replaying = true;
  let draining = false;
  let lastId = afterId;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  const liveBuffer: LiveEvent[] = [];

  const close = (): void => {
    if (closed) return;
    closed = true;
    res.end();
  };
  const onResponseClose = (): void => { closed = true; };
  res.on('close', onResponseClose);

  const writeWithBackpressure = async (payload: string): Promise<void> => {
    if (closed) return;
    if (!res.write(payload)) {
      if (closed) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const onClose = (): void => {
          res.off('drain', onDrain);
          done();
        };
        const onDrain = (): void => {
          res.off('close', onClose);
          done();
        };
        res.once('drain', onDrain);
        res.on('close', onClose);
        if (closed) onClose();
      });
    }
  };
  const writeFrame = async (id: number, type: string, data: unknown): Promise<void> => {
    if (closed || id <= lastId) return;
    await writeWithBackpressure(
      `id: ${id}\n` +
        `event: ${type}\n` +
        `data: ${JSON.stringify(data)}\n\n`,
    );
    lastId = id;
    if (TERMINAL_EVENTS.has(type)) close();
  };

  const drainLive = async (): Promise<void> => {
    if (draining || replaying) return;
    draining = true;
    try {
      liveBuffer.sort((a, b) => a.id - b.id);
      while (!closed && liveBuffer.length > 0) {
        const event = liveBuffer.shift()!;
        await writeFrame(event.id, event.eventType, event.data);
      }
    } finally {
      draining = false;
    }
  };

  const onLive = (event: LiveEvent): void => {
    if (closed) return;
    liveBuffer.push(event);
    if (!replaying) void drainLive().catch(close);
  };

  // Subscribe before the first replay read. Events emitted during replay are
  // buffered and deduplicated by their monotonic ids when live draining starts.
  runner.on(channel, onLive);

  try {
    const replay = await store.getEvents(jobId, afterId);
    for (const event of replay) {
      if (closed) return;
      await writeFrame(event.id, event.eventType, event.data);
    }

    const job = await store.getJob(jobId);
    // Catch events appended while the first replay/status reads were in flight.
    const catchUp = await store.getEvents(jobId, lastId);
    for (const event of catchUp) {
      if (closed) return;
      await writeFrame(event.id, event.eventType, event.data);
    }

    replaying = false;
    await drainLive();
    if (closed) return;

    if (job && TERMINAL_STATUSES.has(job.status)) {
      // JobStore terminal transitions and their terminal events are atomic,
      // so one final cursor read is sufficient even for network-backed stores.
      const terminalCatchUp = await store.getEvents(jobId, lastId);
      for (const event of terminalCatchUp) {
        if (closed) return;
        await writeFrame(event.id, event.eventType, event.data);
      }
      await drainLive();
      if (!closed) close();
      return;
    }

    if (pollMs > 0) {
      pollTimer = setInterval(() => {
        if (closed || polling) return;
        polling = true;
        void store.getEvents(jobId, lastId)
          .then(async (events) => {
            for (const event of events) {
              liveBuffer.push({
                id: event.id,
                jobId: event.jobId,
                eventType: event.eventType,
                data: event.data,
                createdAt: event.createdAt.toISOString(),
              });
            }
            await drainLive();
          })
          .catch(close)
          .finally(() => { polling = false; });
      }, pollMs);
      pollTimer.unref?.();
    }

    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (closed || draining) return;
        void writeWithBackpressure(`: keepalive ${Date.now()}\n\n`).catch(close);
      }, heartbeatMs);
      heartbeat.unref?.();
    }

    await new Promise<void>((resolve) => res.on('close', resolve));
  } finally {
    replaying = false;
    if (heartbeat) clearInterval(heartbeat);
    if (pollTimer) clearInterval(pollTimer);
    res.off('close', onResponseClose);
    runner.off(channel, onLive);
  }
}
