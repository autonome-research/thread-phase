/**
 * Pipeline extension — chains multiple agents through a Thread.
 *
 * Demonstrates the agent-handoff shape:
 *  - claudeCodeAgent writes code
 *  - codexAgent reviews it
 *  - anthropicAgent synthesizes the final summary
 *
 * State flows between adapters via the Thread primitive — canonical
 * AgentEvents plus per-adapter resume tokens.
 *
 * One-shot (invoke with `thread-phase run heterogeneous-chain`).
 */

import {
  PipelineCache,
  requireCtx,
  type BasePipelineContext,
  type Phase,
} from '@autonome-research/thread-phase';
import {
  createEventBus,
  createThread,
  withThread,
  type AgentEventBus,
  type Thread,
} from '@autonome-research/thread-phase/agents';
import {
  claudeCodeAgent,
  codexAgent,
  anthropicAgent,
} from '@autonome-research/thread-phase-agents';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

interface ChainCtx extends BasePipelineContext {
  prompt: string;
  thread: Thread;
  bus: AgentEventBus;
  code?: string;
  review?: string;
  summary?: string;
}

const codegen: Phase<ChainCtx> = {
  name: 'codegen',
  async *run(ctx) {
    const adapter = withThread(claudeCodeAgent, ctx.thread);
    const run = adapter.adapter(
      {
        cwd: process.cwd(),
        prompt: `Write a small TS function for: ${ctx.prompt}`,
      },
      { bus: ctx.bus },
    );
    for await (const _ of run.events) void _;
    const result = await run.result;
    ctx.code = result.text;
    yield { type: 'data', key: 'code', value: ctx.code };
  },
};

const review: Phase<ChainCtx> = {
  name: 'review',
  async *run(ctx) {
    const code = requireCtx(ctx, 'code', 'review');
    const adapter = withThread(codexAgent, ctx.thread);
    const run = adapter.adapter(
      { instruction: `Review this code for bugs:\n\n${code}` },
      { bus: ctx.bus },
    );
    for await (const _ of run.events) void _;
    const result = await run.result;
    ctx.review = result.text;
    yield { type: 'data', key: 'review', value: ctx.review };
  },
};

const synthesize: Phase<ChainCtx> = {
  name: 'synthesize',
  async *run(ctx) {
    const code = requireCtx(ctx, 'code', 'synthesize');
    const review = requireCtx(ctx, 'review', 'synthesize');
    const adapter = withThread(anthropicAgent, ctx.thread);
    const run = adapter.adapter(
      {
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: `Code:\n${code}\n\nReview:\n${review}\n\nSummarize in one paragraph.`,
          },
        ],
        max_tokens: 500,
      },
      { bus: ctx.bus },
    );
    for await (const _ of run.events) void _;
    const result = await run.result;
    ctx.summary = result.text;
    yield { type: 'data', key: 'summary', value: ctx.summary };
  },
};

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<ChainCtx, void>('heterogeneous-chain', {
    phases: [codegen, review, synthesize],
    ctx: () => ({
      cache: new PipelineCache(),
      prompt: 'a function that sums a list of integers',
      thread: createThread(),
      bus: createEventBus(),
    }),
    description:
      'claude-code → codex → anthropic, state carried via Thread + bus',
  });
};
