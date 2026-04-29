/**
 * sse-server — JobRunner + streamToSSE in a small HTTP handler.
 *
 * Shows the canonical "job runs in background, frontend consumes via SSE"
 * pattern. POST /jobs starts a pipeline; GET /jobs/:id/events streams its
 * events as Server-Sent Events with replay-on-reconnect via Last-Event-ID.
 *
 * Run:  npx tsx examples/sse-server.ts
 *
 * Then in another terminal:
 *   curl -X POST http://localhost:3000/jobs
 *   curl -N http://localhost:3000/jobs/<jobId>/events
 *
 * Or open the static page printed at startup.
 *
 * No Express dependency — uses Node's built-in http module.
 */

import { createServer } from 'http';
import {
  PipelineCache,
  JobRunner,
  SqliteJobStore,
  streamToSSE,
  type BasePipelineContext,
  type Phase,
} from '../src/index.js';

interface Ctx extends BasePipelineContext {
  result?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const dbPath = '/tmp/thread-phase-sse-example.db';
const store = new SqliteJobStore(dbPath);
const runner = new JobRunner(store);

// A toy pipeline: three phases that each take ~1s and yield progress events.
const buildDemoPipeline = (): Phase<Ctx>[] => [
  {
    name: 'fetch',
    async *run() {
      yield { type: 'phase', phase: 'fetch', detail: 'starting' };
      for (let i = 0; i < 3; i++) {
        await sleep(300);
        yield { type: 'content', content: `fetch progress ${i + 1}/3\n` };
      }
      yield { type: 'phase', phase: 'fetch', detail: 'done' };
    },
  },
  {
    name: 'process',
    async *run(ctx) {
      yield { type: 'phase', phase: 'process', detail: 'starting' };
      await sleep(800);
      ctx.result = 'processed-result';
      yield { type: 'data', key: 'process', value: ctx.result };
    },
  },
  {
    name: 'finalize',
    async *run() {
      yield { type: 'phase', phase: 'finalize' };
      await sleep(400);
      yield { type: 'content', content: 'all done\n' };
    },
  },
];

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/jobs') {
    const jobId = runner.create('demo', { startedAt: new Date().toISOString() });
    // Fire-and-forget: pipeline runs in the background; HTTP returns immediately.
    void runner.run(jobId, buildDemoPipeline(), { cache: new PipelineCache() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobId }));
    return;
  }

  const sseMatch = req.url?.match(/^\/jobs\/([^/]+)\/events$/);
  if (req.method === 'GET' && sseMatch) {
    const jobId = sseMatch[1]!;
    const lastIdHeader = req.headers['last-event-id'];
    const afterId =
      typeof lastIdHeader === 'string' ? Number(lastIdHeader) || 0 : 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    void streamToSSE({ runner, store, jobId, res, afterId });
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html>
<title>thread-phase SSE demo</title>
<h1>thread-phase SSE demo</h1>
<button onclick="start()">Start job</button>
<pre id="out"></pre>
<script>
async function start() {
  const out = document.getElementById('out');
  out.textContent = '';
  const r = await fetch('/jobs', { method: 'POST' });
  const { jobId } = await r.json();
  out.textContent += 'jobId: ' + jobId + '\\n\\n';
  const es = new EventSource('/jobs/' + jobId + '/events');
  ['phase', 'content', 'data', 'done', 'error'].forEach((type) => {
    es.addEventListener(type, (e) => {
      out.textContent += '[' + type + '] ' + e.data + '\\n';
      if (type === 'done' || type === 'error') es.close();
    });
  });
}
</script>`);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(3000, () => {
  console.log('thread-phase SSE demo listening on http://localhost:3000');
  console.log('Open the page or:');
  console.log('  curl -X POST http://localhost:3000/jobs');
  console.log('  curl -N http://localhost:3000/jobs/<jobId>/events');
});
