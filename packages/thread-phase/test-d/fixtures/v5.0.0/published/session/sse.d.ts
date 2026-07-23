/**
 * Server-Sent Events bridge for JobRunner live events plus JobStore replay.
 * Event ids are store cursors, allowing clients to resume with Last-Event-ID.
 */
import type { JobStore } from './job-store.js';
import type { JobRunner } from './job-runner.js';
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
/** Pump a job's events until terminal state or client disconnect. */
export declare function streamToSSE(options: StreamToSSEOptions): Promise<void>;
//# sourceMappingURL=sse.d.ts.map