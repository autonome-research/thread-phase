/**
 * multi-phase-pipeline — composing phases linearly with one parallel branch.
 *
 * Pipeline:
 *   1. extract       — pull two named entities from the input text
 *   2. parallelPhases — concurrently summarize each entity
 *   3. combine       — merge the two summaries into one paragraph
 *
 * Demonstrates: typed ctx, requireCtx loud failures, parallelPhases
 * composition, runPipeline as the top-level driver.
 *
 * Run:  npx tsx examples/multi-phase-pipeline.ts
 */

import {
  PipelineCache,
  createInferenceClient,
  loadInferenceConfig,
  parseJSON,
  requireCtx,
  runAgentWithTools,
  runPipeline,
  type BasePipelineContext,
  type Phase,
  type ToolExecutor,
} from '../src/index.js';
import { parallelPhases } from '../src/patterns/index.js';

interface Ctx extends BasePipelineContext {
  source?: string;
  entities?: { topic: string; person: string };
  topicSummary?: string;
  personSummary?: string;
  combined?: string;
}

const config = loadInferenceConfig();
const client = createInferenceClient();
const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

const SOURCE = `
Ada Lovelace, working with Charles Babbage on the Analytical Engine in
1843, published the first algorithm intended to be processed by a machine.
The design itself was never built in her lifetime, but her notes are now
considered the seed of computer science.
`.trim();

const extractEntities: Phase<Ctx> = {
  name: 'extract',
  async *run(ctx) {
    yield { type: 'phase', phase: 'extract', detail: 'extracting entities' };
    ctx.source = SOURCE;
    const r = await runAgentWithTools(
      {
        name: 'extractor',
        systemPrompt:
          'Extract one topic and one person from the text. Reply ONLY as JSON: {"topic": "...", "person": "..."}.',
        model: config.defaultModel,
        tools: [],
        maxToolRounds: 1,
        maxTokens: 200,
      },
      [{ role: 'user', content: SOURCE }],
      { client, toolExecutor: noTools, cache: ctx.cache },
    );
    ctx.entities = parseJSON(r.text, { topic: '', person: '' });
    yield { type: 'data', key: 'entities', value: ctx.entities };
  },
};

const summarizeTopic: Phase<Ctx> = {
  name: 'summarize-topic',
  async *run(ctx) {
    const e = requireCtx(ctx, 'entities', 'summarize-topic');
    yield { type: 'phase', phase: 'summarize-topic', detail: e.topic };
    const r = await runAgentWithTools(
      {
        name: 'topic-summarizer',
        systemPrompt: 'In one sentence, describe the topic. No preamble.',
        model: config.defaultModel,
        tools: [],
        maxToolRounds: 1,
        maxTokens: 120,
      },
      [{ role: 'user', content: `Topic: ${e.topic}` }],
      { client, toolExecutor: noTools, cache: ctx.cache },
    );
    ctx.topicSummary = r.text.trim();
  },
};

const summarizePerson: Phase<Ctx> = {
  name: 'summarize-person',
  async *run(ctx) {
    const e = requireCtx(ctx, 'entities', 'summarize-person');
    yield { type: 'phase', phase: 'summarize-person', detail: e.person };
    const r = await runAgentWithTools(
      {
        name: 'person-summarizer',
        systemPrompt: 'In one sentence, describe the person. No preamble.',
        model: config.defaultModel,
        tools: [],
        maxToolRounds: 1,
        maxTokens: 120,
      },
      [{ role: 'user', content: `Person: ${e.person}` }],
      { client, toolExecutor: noTools, cache: ctx.cache },
    );
    ctx.personSummary = r.text.trim();
  },
};

const combine: Phase<Ctx> = {
  name: 'combine',
  async *run(ctx) {
    const t = requireCtx(ctx, 'topicSummary', 'combine');
    const p = requireCtx(ctx, 'personSummary', 'combine');
    ctx.combined = `${p}\n${t}`;
    yield { type: 'data', key: 'combined', value: ctx.combined };
  },
};

const ctx: Ctx = { cache: new PipelineCache() };
for await (const event of runPipeline(
  [extractEntities, parallelPhases('summarize', [summarizeTopic, summarizePerson]), combine],
  ctx,
)) {
  if (event.type === 'phase') {
    console.log(`[${event.phase}] ${event.detail ?? ''}`);
  } else if (event.type === 'data' && event.key === 'combined') {
    console.log('\n--- combined ---\n' + (event.value as string));
  }
}
