/**
 * End-to-end smoke test against an OpenAI-compatible inference endpoint.
 *
 * Exercises every layer of thread-phase:
 *   1. Inference config loading + client construction
 *   2. runAgentWithTools — no-tools chat path
 *   3. runAgentWithTools — tool round-trip (call → execute → result → answer)
 *   4. Composed pipeline through runPipeline + JobStore + JobRunner,
 *      including resumable event log + requireCtx loud-failure check.
 *
 * Defaults to local vLLM at http://localhost:8000/v1; override via env
 * (INFERENCE_BASE_URL, INFERENCE_MODEL — see .env.example).
 *
 * Run after `npm run build`:  node examples/smoke.js
 */

import { unlinkSync, existsSync } from 'fs';

import {
  PipelineCache,
  SqliteJobStore,
  JobRunner,
  createInferenceClient,
  loadInferenceConfig,
  runAgentWithTools,
  parseJSON,
  requireCtx,
  type Phase,
  type BasePipelineContext,
  type ToolExecutor,
} from '../src/index.js';

interface Ctx extends BasePipelineContext {
  number?: number;
  doubled?: number;
  report?: string;
}

const config = loadInferenceConfig();
const client = createInferenceClient();
const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

// =============================================================================
// Stage 1: config
// =============================================================================
console.log('=== Stage 1: config ===');
console.log({ baseUrl: config.baseUrl, model: config.defaultModel, ctx: config.contextLength });

// =============================================================================
// Stage 2: no-tools agent
// =============================================================================
console.log('\n=== Stage 2: no-tools agent ===');
const noToolResult = await runAgentWithTools(
  {
    name: 'no-tools-agent',
    systemPrompt: 'You are a helpful assistant. Reply in JSON: {"answer": "..."}.',
    model: config.defaultModel,
    tools: [],
    maxToolRounds: 1,
    maxTokens: 500,
  },
  [{ role: 'user', content: 'What is 2+2? Reply with JSON only.' }],
  { client, toolExecutor: noTools },
);
console.log('text:', noToolResult.text.trim().slice(0, 200));
console.log('parsed:', parseJSON(noToolResult.text, { answer: 'PARSE_FAIL' }));

// =============================================================================
// Stage 3: tool round-trip
// =============================================================================
console.log('\n=== Stage 3: tool round-trip ===');
const fakeWeather: ToolExecutor = {
  async execute(name, toolCallId, args) {
    console.log('  >>> tool called:', name, args);
    return {
      toolCallId,
      content: JSON.stringify({ city: args.city, temp_c: 14, conditions: 'overcast' }),
    };
  },
};
const toolResult = await runAgentWithTools(
  {
    name: 'tool-agent',
    systemPrompt:
      'When asked about weather, call get_weather. After receiving the result, answer the user briefly.',
    model: config.defaultModel,
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather in a city.',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    ],
    maxToolRounds: 4,
    maxTokens: 500,
  },
  [{ role: 'user', content: 'What is the weather in Paris?' }],
  { client, toolExecutor: fakeWeather },
);
console.log('final text:', toolResult.text.trim().slice(0, 200));

// =============================================================================
// Stage 4: composed pipeline + JobStore + JobRunner
// =============================================================================
console.log('\n=== Stage 4: pipeline + persistence ===');

const askPhase: Phase<Ctx> = {
  name: 'ask',
  async *run(ctx) {
    yield { type: 'phase', phase: 'ask', detail: 'asking for a number' };
    const r = await runAgentWithTools(
      {
        name: 'asker',
        model: config.defaultModel,
        systemPrompt: 'Reply ONLY with JSON: {"number": <integer>}. No prose.',
        tools: [],
        maxToolRounds: 1,
        maxTokens: 500,
      },
      [{ role: 'user', content: 'Pick the integer 7. Return it.' }],
      { client, toolExecutor: noTools, cache: ctx.cache },
    );
    ctx.number = parseJSON<{ number: number }>(r.text, { number: 0 }).number;
    yield { type: 'content', content: `picked ${ctx.number}\n` };
  },
};

const doublePhase: Phase<Ctx> = {
  name: 'double',
  async *run(ctx) {
    const n = requireCtx(ctx, 'number', 'double');
    yield { type: 'phase', phase: 'double', detail: `doubling ${n}` };
    const r = await runAgentWithTools(
      {
        name: 'doubler',
        model: config.defaultModel,
        systemPrompt: 'Reply ONLY with JSON: {"result": <integer>}. No prose.',
        tools: [],
        maxToolRounds: 1,
        maxTokens: 500,
      },
      [{ role: 'user', content: `What is ${n} doubled? Reply JSON.` }],
      { client, toolExecutor: noTools, cache: ctx.cache },
    );
    ctx.doubled = parseJSON<{ result: number }>(r.text, { result: -1 }).result;
    yield { type: 'content', content: `doubled to ${ctx.doubled}\n` };
  },
};

const reportPhase: Phase<Ctx> = {
  name: 'report',
  async *run(ctx) {
    const n = requireCtx(ctx, 'number', 'report');
    const d = requireCtx(ctx, 'doubled', 'report');
    ctx.report = `Picked ${n}, doubled to ${d}.`;
    yield { type: 'data', key: 'report', value: ctx.report };
  },
};

const dbPath = '/tmp/thread-phase-smoke.db';
if (existsSync(dbPath)) unlinkSync(dbPath);
const store = new SqliteJobStore(dbPath);
const runner = new JobRunner(store);
const jobId = runner.create('arithmetic-pipeline', { task: 'pick-and-double' });

const liveEvents: Array<{ id: number; type: string }> = [];
runner.on(`job:${jobId}`, (e: { id: number; eventType: string }) =>
  liveEvents.push({ id: e.id, type: e.eventType }),
);

const ctx: Ctx = { cache: new PipelineCache() };
await runner.run(jobId, [askPhase, doublePhase, reportPhase], ctx, () => ({
  report: ctx.report,
  number: ctx.number,
  doubled: ctx.doubled,
}));

const job = store.getJob(jobId)!;
console.log('job status:', job.status);
console.log('job result:', job.result);
console.log('event count:', job.eventCount, '— live emitted:', liveEvents.length);
console.log(
  'persisted events:',
  store.getEvents(jobId).map((e) => `${e.id}:${e.eventType}`).join(' '),
);
console.log(
  'resume from id 3:',
  store.getEvents(jobId, 3).map((e) => `${e.id}:${e.eventType}`).join(' '),
);

// requireCtx negative test
let caught: string | null = null;
try {
  const ctx2: Ctx = { cache: new PipelineCache() };
  for await (const _ of doublePhase.run(ctx2)) {
    void _;
  }
} catch (err: unknown) {
  caught = err instanceof Error ? err.message : String(err);
}
console.log('requireCtx negative test:', caught ? 'OK' : 'FAIL');

store.close();
unlinkSync(dbPath);
console.log('\nSMOKE OK');
