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
 * both satisfy this without modification.
 */
export interface SSEResponse {
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close', listener: () => void): void;
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

  const writeFrame = (id: number, type: string, data: unknown): boolean => {
    if (closed) return false;
    const payload =
      `id: ${id}\n` +
      `event: ${type}\n` +
      `data: ${JSON.stringify(data)}\n\n`;
    return res.write(payload);
  };

  // Step 1: replay anything the client has missed.
  let lastId = afterId;
  const replay = store.getEvents(jobId, afterId);
  for (const evt of replay) {
    writeFrame(evt.id, evt.eventType, evt.data);
    lastId = Math.max(lastId, evt.id);
  }

  // If the job is already finished and replay covered everything, close.
  const job = store.getJob(jobId);
  if (job && (job.status === 'COMPLETED' || job.status === 'FAILED')) {
    close();
    return;
  }

  // Step 2: subscribe to live events. Buffer events that arrived during
  // replay if their id is past lastId (otherwise they're already sent).
  const channel = `job:${jobId}`;
  const onLive = (evt: LiveEvent) => {
    if (closed) return;
    if (evt.id <= lastId) return;
    lastId = evt.id;
    writeFrame(evt.id, evt.eventType, evt.data);
    if (evt.eventType === 'done' || evt.eventType === 'error') {
      close();
    }
  };
  runner.on(channel, onLive);

  // Heartbeat: comment line every N seconds to keep proxies from idling out.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (closed) return;
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
