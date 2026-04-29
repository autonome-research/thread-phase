/**
 * agent-authored-cron — what an agent might generate when asked:
 *
 *   "Set up a daily automation: fetch new articles, triage which ones are
 *   worth reading, summarize the kept ones, and compose a single digest
 *   paragraph I can email myself."
 *
 * The shape this example demonstrates:
 *
 *   1. A typed Ctx so each phase advertises what it reads/writes.
 *   2. Phases do the deterministic structure (ordering, fan-out, ctx flow).
 *   3. Agents do the *judgment* inside each phase (which articles to keep,
 *      how to summarize, how to compose).
 *   4. verifyResult catches confabulation — the run-time agent might claim
 *      "I summarized 4 articles" but executedToolCalls says zero, or the
 *      composed text might be empty when finishReason is 'length'.
 *   5. JobRunner persists the event log so the structuring agent can debug
 *      what actually happened on yesterday's run.
 *
 * The cron entry that ends up in crontab is literally:
 *
 *   0 7 * * *  cd /path/to/project && npx tsx examples/agent-authored-cron.ts
 *
 * No prompt. No "trust the agent to do the right thing on the next call."
 * The agent's judgment is bounded by the typed phase structure.
 *
 * Run:  npx tsx examples/agent-authored-cron.ts
 *       (works without a real inference endpoint — uses a deterministic
 *       fake client at the bottom of the file. Swap in
 *       createInferenceClient() for real use.)
 */

import {
  PipelineCache,
  JobRunner,
  SqliteJobStore,
  parseJSON,
  requireCtx,
  runAgentWithTools,
  type AgentRunnerOptions,
  type BasePipelineContext,
  type Phase,
  type ToolExecutor,
} from '../src/index.js';
import { boundedFanout } from '../src/patterns/index.js';

// ---------------------------------------------------------------------------
// Typed context — every phase's input/output is part of the contract.
// ---------------------------------------------------------------------------

interface Article {
  id: string;
  title: string;
  body: string;
}

interface Triaged {
  article: Article;
  keep: boolean;
  reason: string;
}

interface Ctx extends BasePipelineContext {
  fetched?: Article[];
  triaged?: Triaged[];
  summaries?: Array<{ id: string; summary: string }>;
  digest?: string;
}

// ---------------------------------------------------------------------------
// Phase 1: fetch.
//
// In a real automation this would hit your data source — RSS feeds, an
// inbox, a vault directory, an arxiv query, etc. Hardcoded here for a
// runnable demo.
// ---------------------------------------------------------------------------

const fetchPhase: Phase<Ctx> = {
  name: 'fetch',
  async *run(ctx) {
    yield { type: 'phase', phase: 'fetch', detail: 'fetching new articles' };
    ctx.fetched = [
      {
        id: 'a1',
        title: 'New approach to retrieval-augmented generation',
        body: 'Researchers describe a method for...',
      },
      {
        id: 'a2',
        title: 'My cat learned to open doors',
        body: 'Posted on /r/cats today...',
      },
      {
        id: 'a3',
        title: 'Compiler benchmarks across LLVM versions',
        body: 'Comparing LLVM 17 through 19 on standard suites...',
      },
    ];
    yield { type: 'data', key: 'fetched', value: { count: ctx.fetched.length } };
  },
};

// ---------------------------------------------------------------------------
// Phase 2: triage.
//
// AGENT JUDGMENT: which articles are worth keeping? Returns a typed
// decision per article. Uses parseJSON so a malformed model response
// falls back to a sensible default (keep=false) rather than crashing.
// ---------------------------------------------------------------------------

const triagePhase: Phase<Ctx> = {
  name: 'triage',
  async *run(ctx) {
    const articles = requireCtx(ctx, 'fetched', 'triage');
    yield { type: 'phase', phase: 'triage', detail: `triaging ${articles.length}` };

    const triaged = await boundedFanout({
      items: articles,
      concurrency: 3,
      runner: async (article): Promise<Triaged> => {
        const result = await runAgentWithTools(
          {
            name: 'triage-agent',
            systemPrompt:
              'Decide if this article is worth reading for a daily technical digest. ' +
              'Reply ONLY as JSON: {"keep": boolean, "reason": "<one sentence>"}.',
            model: config.defaultModel,
            tools: [],
            maxToolRounds: 1,
            maxTokens: 150,
          },
          [{ role: 'user', content: `Title: ${article.title}\n\n${article.body}` }],
          { client, toolExecutor: noTools, cache: ctx.cache },
        );
        // finishReason='length' means the model was truncated — treat as
        // failure-to-decide rather than trusting parseJSON's fallback.
        if (result.finishReason === 'length') {
          return { article, keep: false, reason: 'triage truncated; defaulting to skip' };
        }
        const decision = parseJSON<{ keep: boolean; reason: string }>(result.text, {
          keep: false,
          reason: 'parse failed',
        });
        return { article, keep: decision.keep, reason: decision.reason };
      },
    });

    ctx.triaged = triaged;
    const kept = triaged.filter((t) => t.keep).length;
    yield { type: 'data', key: 'triaged', value: { kept, dropped: triaged.length - kept } };
  },
};

// ---------------------------------------------------------------------------
// Phase 3: summarize.
//
// AGENT JUDGMENT: how to summarize each kept article. Concurrency-capped
// so we don't fire all summarizer calls at once.
//
// verifyResult here catches a real failure mode: the run-time agent might
// return text but the inference call might have been truncated, leaving
// us with "The article describ..." — useless as a summary. We check
// finishReason and require non-trivial length.
// ---------------------------------------------------------------------------

const summarizePhase: Phase<Ctx> = {
  name: 'summarize',
  async *run(ctx) {
    const triaged = requireCtx(ctx, 'triaged', 'summarize');
    const kept = triaged.filter((t) => t.keep);
    yield { type: 'phase', phase: 'summarize', detail: `summarizing ${kept.length} kept` };

    const summaries = await boundedFanout({
      items: kept,
      concurrency: 3,
      runner: async ({ article }) => {
        const result = await runAgentWithTools(
          {
            name: 'summarizer',
            systemPrompt:
              'Summarize the article in two sentences. No preamble, no apology, just the summary.',
            model: config.defaultModel,
            tools: [],
            maxToolRounds: 1,
            maxTokens: 200,
          },
          [{ role: 'user', content: `Title: ${article.title}\n\n${article.body}` }],
          {
            client,
            toolExecutor: noTools,
            cache: ctx.cache,
            // verifyResult catches "looks like a summary but isn't one":
            // truncated output, single-word replies, etc.
            verifyResult: (r) => {
              if (r.finishReason === 'length') {
                throw new Error(`summary for ${article.id} was truncated`);
              }
              if (r.text.trim().length < 30) {
                throw new Error(`summary for ${article.id} was too short`);
              }
              return r;
            },
          } as AgentRunnerOptions,
        );
        return { id: article.id, summary: result.text.trim() };
      },
    });

    ctx.summaries = summaries;
    yield { type: 'data', key: 'summaries', value: { count: summaries.length } };
  },
};

// ---------------------------------------------------------------------------
// Phase 4: compose.
//
// AGENT JUDGMENT: how to weave the per-article summaries into a single
// readable digest. Final output goes to ctx.digest. The cron entry's
// caller (or a shell wrapper) reads stdout and emails it.
// ---------------------------------------------------------------------------

const composePhase: Phase<Ctx> = {
  name: 'compose',
  async *run(ctx) {
    const summaries = requireCtx(ctx, 'summaries', 'compose');
    if (summaries.length === 0) {
      ctx.digest = 'No new articles worth reading today.';
      yield { type: 'data', key: 'digest', value: 'empty' };
      return;
    }
    yield { type: 'phase', phase: 'compose', detail: 'composing digest' };
    const result = await runAgentWithTools(
      {
        name: 'composer',
        systemPrompt:
          'Compose a daily technical digest paragraph from the per-article summaries below. ' +
          'One readable paragraph, ~3-5 sentences, weave the topics together naturally.',
        model: config.defaultModel,
        tools: [],
        maxToolRounds: 1,
        maxTokens: 600,
      },
      [
        {
          role: 'user',
          content: summaries.map((s) => `[${s.id}] ${s.summary}`).join('\n\n'),
        },
      ],
      { client, toolExecutor: noTools, cache: ctx.cache },
    );
    if (result.finishReason === 'length') {
      // Don't silently emit a truncated digest. Mark the phase as failed
      // so the orchestrator surfaces a real error event.
      throw new Error('composer output was truncated; refusing to emit a half-digest');
    }
    ctx.digest = result.text.trim();
    yield { type: 'content', content: ctx.digest + '\n' };
  },
};

// ---------------------------------------------------------------------------
// Entry point — what cron actually runs.
//
// JobRunner persists the event log to a sqlite file. The structuring
// agent (you, or a future agent) can read jobs.db to debug yesterday's
// run without needing to scrape journald.
// ---------------------------------------------------------------------------

const config = (await import('../src/inference.js')).loadInferenceConfig();
const client = makeFakeClient(); // swap for createInferenceClient() in real use
const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

const dbPath = process.env.JOBS_DB ?? '/tmp/thread-phase-cron-example.db';
const store = new SqliteJobStore(dbPath);
const runner = new JobRunner(store);

const jobId = runner.create('daily-digest', { startedAt: new Date().toISOString() });
const ctx: Ctx = { cache: new PipelineCache() };

// Wire SIGINT / SIGTERM to runner.cancel so a stuck inference call doesn't
// strand the systemd timer past its TimeoutStartSec.
const onSignal = () => runner.cancel(jobId, 'systemd timeout / SIGTERM');
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

await runner.run(jobId, [fetchPhase, triagePhase, summarizePhase, composePhase], ctx, () => ({
  digest: ctx.digest,
  count: ctx.summaries?.length ?? 0,
}));

const finalJob = store.getJob(jobId)!;
console.log('---');
console.log(`status: ${finalJob.status}`);
if (ctx.digest) console.log('\n' + ctx.digest);
if (finalJob.error) console.log(`\nerror: ${finalJob.error}`);

store.close();

// ---------------------------------------------------------------------------
// Fake client — deterministic responses so this example runs without a
// real inference endpoint. Replace with createInferenceClient() in real use.
// ---------------------------------------------------------------------------

function makeFakeClient(): any {
  type Choice = { delta: { content?: string }; finish_reason: string | null };
  const respond = (text: string) =>
    ({
      async *[Symbol.asyncIterator]() {
        yield {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'm',
          choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' } as Choice],
        };
        yield {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'm',
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };
      },
    }) as any;
  return {
    chat: {
      completions: {
        create: async (body: any) => {
          const sys = body.messages.find((m: any) => m.role === 'system')?.content ?? '';
          const user = body.messages[body.messages.length - 1]?.content ?? '';
          if (sys.includes('Decide if this article')) {
            // Keep technical articles, drop the cat story.
            const keep = !user.includes('cat');
            return respond(
              JSON.stringify({
                keep,
                reason: keep ? 'on-topic technical content' : 'off-topic personal anecdote',
              }),
            );
          }
          if (sys.includes('Summarize the article')) {
            return respond(
              'A research result describes a structured improvement on prior work, with quantified comparisons across baselines.',
            );
          }
          if (sys.includes('Compose a daily technical digest')) {
            return respond(
              "Today's reading covers two technically substantive results: a refined retrieval-augmented generation method, " +
                'and an updated set of compiler benchmarks across recent LLVM releases. Both report quantified improvements ' +
                'over their respective baselines and are worth a closer read this week.',
            );
          }
          return respond('ok');
        },
      },
    },
  };
}
