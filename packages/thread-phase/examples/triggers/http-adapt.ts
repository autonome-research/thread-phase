/**
 * http-adapt — adapt arbitrary HTTP webhooks into the Trigger protocol.
 *
 * thread-phase doesn't ship an HTTP server. This is the recipe for
 * wrapping any HTTP framework (express, fastify, hono, raw node:http,
 * a Cloudflare Worker, an AWS Lambda) into a Trigger. The pattern:
 *
 *   1. Stand up your HTTP server however you want.
 *   2. For each request, push a TriggerEvent into a queue.
 *   3. Your Trigger.start() generator yields from that queue.
 *
 * The example below uses node:http for zero dependencies. Replace it
 * with whatever framework fits your stack.
 *
 * Run: npx tsx examples/triggers/http-adapt.ts
 * Then: curl -X POST -d '{"name":"world"}' http://localhost:3030/hook
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  PipelineCache,
  type BasePipelineContext,
  type Phase,
} from '../../src/index.js';
import {
  runTrigger,
  type Trigger,
  type TriggerEvent,
} from '../../src/triggers/index.js';

interface WebhookPayload {
  name?: string;
  [key: string]: unknown;
}

/**
 * HttpTrigger — wraps a node:http server into a Trigger.
 *
 * One server, one path, JSON bodies. Extend or replace as needed.
 */
class HttpTrigger implements Trigger<WebhookPayload> {
  readonly name: string;
  private server: ReturnType<typeof createServer>;
  private seq = 0;
  private queue: TriggerEvent<WebhookPayload>[] = [];
  private resolveWait: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly port: number,
    private readonly path: string,
  ) {
    this.name = `http:${path}`;
    this.server = createServer(this.onRequest.bind(this));
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== this.path || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: WebhookPayload = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end('invalid JSON');
        return;
      }
      const event: TriggerEvent<WebhookPayload> = {
        id: ++this.seq,
        occurredAt: new Date().toISOString(),
        input: body,
        metadata: {
          remoteAddress: req.socket.remoteAddress ?? '',
          userAgent: String(req.headers['user-agent'] ?? ''),
        },
      };
      this.queue.push(event);
      this.resolveWait?.();
      this.resolveWait = null;
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, eventId: event.id }));
    });
  }

  async *start(): AsyncGenerator<TriggerEvent<WebhookPayload>, void> {
    await new Promise<void>((resolve) => this.server.listen(this.port, resolve));
    console.log(`[${this.name}] listening on http://localhost:${this.port}${this.path}`);

    while (!this.stopped) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.resolveWait = resolve;
        if (this.stopped) resolve();
      });
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.resolveWait?.();
    this.resolveWait = null;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// --- pipeline ---------------------------------------------------------------

interface Ctx extends BasePipelineContext {
  payload: WebhookPayload;
  greeting?: string;
}

const greet: Phase<Ctx> = {
  name: 'greet',
  async *run(ctx) {
    ctx.greeting = `Hello, ${ctx.payload.name ?? 'anonymous'}!`;
    yield { type: 'data', key: 'greeting', value: ctx.greeting };
  },
};

// --- wire it up -------------------------------------------------------------

const trigger = new HttpTrigger(3030, '/hook');

const handle = runTrigger(
  trigger,
  (payload, event) => ({
    phases: [greet],
    ctx: { cache: new PipelineCache(), payload },
  }),
  {
    onStart: (e) => console.log(`[start] ${e.id}: ${JSON.stringify(e.input)}`),
    onComplete: (e) => console.log(`[done]  ${e.id}`),
  },
);

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await handle.stop();
});

await handle.done;
