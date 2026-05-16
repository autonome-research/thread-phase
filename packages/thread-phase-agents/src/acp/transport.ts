/**
 * NDJSON JSON-RPC 2.0 transport over a child-process stdio pair.
 *
 * ACP frames messages as newline-delimited JSON — one JSON-RPC envelope
 * per line, no Content-Length headers. The transport owns the byte-level
 * framing, request/response correlation, and notification dispatch. The
 * adapter layer above translates ACP-specific messages into canonical
 * `AgentEvent`s.
 *
 * Single-process scope: each transport instance binds to one subprocess.
 * Disposing it ends the child's stdin and (optionally) signals the child.
 *
 * @internal
 */

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** A JSON-RPC 2.0 request, response, or notification. @internal */
export type JsonRpcMessage =
  | { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown }
  | { jsonrpc: '2.0'; id: number | string; result: unknown }
  | { jsonrpc: '2.0'; id: number | string; error: JsonRpcError }
  | { jsonrpc: '2.0'; method: string; params?: unknown };

/** JSON-RPC 2.0 error object. @internal */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** @internal */
export class JsonRpcCallError extends Error {
  constructor(public method: string, public rpcError: JsonRpcError) {
    super(`JSON-RPC error from ${method}: ${rpcError.message} (code ${rpcError.code})`);
    this.name = 'JsonRpcCallError';
  }
}

/** @internal */
export interface AcpTransportOptions {
  /** The spawned child whose stdio we'll speak over. */
  child: ChildProcessByStdio<Writable, Readable, Readable | null>;
  /**
   * Called on every notification received from the agent. Notifications
   * are method calls without an `id` — the transport routes them here.
   */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Called on every request the agent makes back at the client (e.g.
   * session/request_permission). The handler returns the response value
   * which the transport replies with. If no handler is set or the
   * handler throws, the transport responds with a JSON-RPC method-not-
   * found error.
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Called when the underlying stream emits a parse error or closes unexpectedly. */
  onTransportError?: (err: Error) => void;
}

/**
 * Build a transport bound to the given child's stdio. The transport
 * starts reading immediately. Call `dispose()` to release listeners and
 * close stdin.
 *
 * @internal
 */
export function createAcpTransport(opts: AcpTransportOptions): AcpTransport {
  const { child, onNotification, onRequest, onTransportError } = opts;

  const pending = new Map<number | string, { resolve(v: unknown): void; reject(e: unknown): void; method: string }>();
  let nextId = 1;
  let buffer = '';
  let disposed = false;

  const writeMessage = (msg: JsonRpcMessage): void => {
    if (disposed) return;
    const line = JSON.stringify(msg) + '\n';
    // child.stdin is Writable; back-pressure is the caller's problem
    // (we don't await drain — ACP messages are small).
    child.stdin.write(line);
  };

  const handleParsed = (msg: unknown): void => {
    if (!isJsonRpcMessage(msg)) {
      onTransportError?.(new Error(`malformed JSON-RPC message: ${JSON.stringify(msg).slice(0, 200)}`));
      return;
    }
    if ('id' in msg && 'method' in msg) {
      // Request from agent to client.
      void handleAgentRequest(msg.id, msg.method, msg.params);
      return;
    }
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const entry = pending.get(msg.id);
      if (!entry) {
        // Late or unsolicited response — drop quietly. Logging would
        // be the caller's concern if they want it.
        return;
      }
      pending.delete(msg.id);
      if ('error' in msg) {
        entry.reject(new JsonRpcCallError(entry.method, msg.error));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if ('method' in msg) {
      // Notification from agent.
      onNotification?.(msg.method, msg.params);
      return;
    }
    onTransportError?.(new Error(`unknown JSON-RPC message shape: ${JSON.stringify(msg).slice(0, 200)}`));
  };

  const handleAgentRequest = async (
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> => {
    if (!onRequest) {
      writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await onRequest(method, params);
      writeMessage({ jsonrpc: '2.0', id, result });
    } catch (err) {
      writeMessage({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  const consumeBuffer = (): void => {
    while (true) {
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        onTransportError?.(new Error(`JSON parse error on line: ${line.slice(0, 200)}`));
        continue;
      }
      handleParsed(parsed);
    }
  };

  const onStdoutData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    consumeBuffer();
  };

  const onStdoutEnd = (): void => {
    if (buffer.trim().length > 0) consumeBuffer();
    // Reject any still-pending requests so callers don't hang.
    for (const [id, entry] of pending) {
      entry.reject(new Error(`subprocess stdout closed while waiting on ${entry.method}`));
      pending.delete(id);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onStdoutData);
  child.stdout.on('end', onStdoutEnd);
  child.stdout.on('error', (err) => onTransportError?.(err));

  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      if (disposed) {
        return Promise.reject(new Error('transport disposed'));
      }
      const id = nextId++;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
      });
      writeMessage({ jsonrpc: '2.0', id, method, params });
      return promise as Promise<T>;
    },
    notify(method: string, params?: unknown): void {
      writeMessage({ jsonrpc: '2.0', method, params });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      child.stdout.removeListener('data', onStdoutData);
      child.stdout.removeListener('end', onStdoutEnd);
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      // Reject any remaining pending so callers unblock.
      for (const [id, entry] of pending) {
        entry.reject(new Error('transport disposed'));
        pending.delete(id);
      }
    },
  };
}

/** @internal */
export interface AcpTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  dispose(): void;
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'jsonrpc' in value &&
    (value as { jsonrpc?: unknown }).jsonrpc === '2.0'
  );
}
