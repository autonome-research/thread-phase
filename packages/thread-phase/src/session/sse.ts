/**
 * Server-Sent Events helper — adapt a JobRunner live stream + replay log
 * into an SSE wire format for HTTP consumers.
 *
 * Wire shape:
 *   - Each event is `id: <eventId>\nevent: <type>\ndata: <json>\n\n`.
 *   - The eventId is the JobStore's monotonic id, so disconnected clients
 *     can resume by reading `Last-Event-ID` and replaying via JobStore.
 *   - The connection closes after a `done` or `error` event.
 *
 * The helper is framework-agnostic: it writes to a minimal `SSEResponse`
 * interface so it works with Node's `http.ServerResponse`, Express's
 * `Response`, Fastify's reply (after .raw), etc.
 *
 * Typical usage:
 *
 *   app.get('/jobs/:id/events', (req, res) => {
 *     const lastId = Number(req.headers['last-event-id'] ?? 0);
 *     res.writeHead(200, {
 *       'Content-Type': 'text/event-stream',
 *       'Cache-Control': 'no-cache',
 *       'Connection': 'keep-alive',
 *     });
 *     streamToSSE({ runner, store, jobId: req.params.id, res, afterId: lastId });
 *   });
 */

import type { JobStore } from './job-store.js';
import type { JobRunner, LiveEvent } from './job-runner.js';

/**
 * Minimal response interface — `http.ServerResponse` and Express's `Response`
 * both satisfy this without modification. `once(drain)` is required for
 * backpressure handling: when `write()` returns false the socket buffer is
 * full and writes must pause until `drain` fires, or memory grows
 * unboundedly behind a slow client.
 */
export interface SSEResponse {
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close', listener: () => void): void;
  once(event: 'drain', listener: () => void): void;
}

export interface StreamToSSEOptions {
  runner: JobRunner;
  store: JobStore;
  jobId: string;
  res: SSEResponse;
  /**
   * Replay events with id > afterId before subscribing live. Use the value
   * of the client's `Last-Event-ID` header to resume after disconnect.
   */
  afterId?: number;
  /**
   * Heartbeat interval in ms. Default 25s. Sends an SSE comment line to
   * keep proxies and intermediaries from closing the connection. Set 0 to
   * disable.
   */
  heartbeatMs?: number;
}

/**
 * Pump a job's events to an SSE response. Resolves when the connection
 * closes (either because the job ended or the client disconnected).
 */
export async function streamToSSE(options: StreamToSSEOptions): Promise<void> {
  const { runner, store, jobId, res, afterId = 0 } = options;
  const heartbeatMs = options.heartbeatMs ?? 25_000;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    res.end();
  };

  res.on('close', () => {
    closed = true;
  });

  // Backpressure: when res.write() returns false the socket buffer is full
  // and we must wait for 'drain' before continuing. Without this, slow
  // clients cause unbounded Node-side memory growth as writes accumulate.
  const writeWithBackpressure = async (payload: string): Promise<void> => {
    if (closed) return;
    if (!res.write(payload)) {
      await new Promise<void>((resolve) => res.once('drain', resolve));
    }
  };

  const writeFrame = async (id: number, type: string, data: unknown): Promise<void> => {
    if (closed) return;
    await writeWithBackpressure(
      `id: ${id}\n` +
        `event: ${type}\n` +
        `data: ${JSON.stringify(data)}\n\n`,
    );
  };

  // Step 1: replay anything the client has missed.
  let lastId = afterId;
  const replay = await store.getEvents(jobId, afterId);
  for (const evt of replay) {
    if (closed) return;
    await writeFrame(evt.id, evt.eventType, evt.data);
    lastId = Math.max(lastId, evt.id);
  }

  // If the job is already finished and replay covered everything, close.
  const job = await store.getJob(jobId);
  if (job && (job.status === 'COMPLETED' || job.status === 'FAILED')) {
    close();
    return;
  }

  // Step 2: subscribe to live events. The EventEmitter listener is sync
  // and fire-and-forget by API; we buffer events and drain them serially
  // through writeFrame so backpressure stays honored and ordering is
  // preserved even when multiple events arrive while a write is pending.
  const channel = `job:${jobId}`;
  const liveBuffer: LiveEvent[] = [];
  let draining = false;
  const drainLive = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (!closed && liveBuffer.length > 0) {
        const evt = liveBuffer.shift()!;
        if (evt.id <= lastId) continue;
        lastId = evt.id;
        await writeFrame(evt.id, evt.eventType, evt.data);
        if (evt.eventType === 'done' || evt.eventType === 'error') {
          close();
          return;
        }
      }
    } finally {
      draining = false;
    }
  };
  const onLive = (evt: LiveEvent): void => {
    if (closed) return;
    liveBuffer.push(evt);
    // Promise rejection here would be unobserved by the EventEmitter, so
    // catch and swallow — writes that fail close the socket anyway.
    void drainLive().catch(() => {
      /* connection error during drain; close listener will fire */
    });
  };
  runner.on(channel, onLive);

  // Heartbeat: comment line every N seconds to keep proxies from idling
  // out. Skip the heartbeat when the socket is back-pressured rather than
  // queueing — heartbeats are advisory and stale ones are not useful.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (closed) return;
      // Discard the boolean intentionally: this is a hint, not data.
      // Backpressure is handled by event writes, which will pause the
      // pipeline once drain is pending.
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, heartbeatMs);
  }

  // Wait until the connection closes.
  await new Promise<void>((resolve) => {
    res.on('close', resolve);
  });

  if (heartbeat) clearInterval(heartbeat);
  runner.off(channel, onLive);
}
