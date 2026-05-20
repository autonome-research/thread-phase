/**
 * Honcho as a MemoryProvider for thread-phase.
 *
 * thread-phase ships only the `MemoryProvider` interface — no bundled
 * backend. This example shows the minimal binding to Honcho
 * (https://github.com/plastic-labs/honcho): a workspace/peer/session
 * model with derived per-user context.
 *
 * Run:
 *   npm install @honcho-ai/sdk
 *   HONCHO_API_KEY=... npx tsx examples/honcho-memory.ts
 *
 * The example runs a tiny pipeline that (1) recalls per-user memory
 * before invoking an agent, (2) runs the agent, (3) writes the
 * conversation back to Honcho. Across runs, the agent picks up where
 * it left off — without thread-phase persisting anything beyond its
 * own JobStore event log.
 */

import { Honcho } from '@honcho-ai/sdk';

import {
  PipelineCache,
  ToolRegistry,
  createInferenceClient,
  loadInferenceConfig,
  parseJSON,
  requireCtx,
  runAgentWithTools,
  type AgentRunnerOptions,
  type BasePipelineContext,
  type Message,
  type Phase,
  type ToolExecutor,
} from '@autonome-research/thread-phase';
import type {
  AgentEvent,
  MemoryProvider,
  MemoryScope,
} from '@autonome-research/thread-phase/agents';

// ---------------------------------------------------------------------------
// Honcho binding
// ---------------------------------------------------------------------------

/**
 * Adapt Honcho to thread-phase's `MemoryProvider` interface.
 *
 * - `recall` asks Honcho for the peer's distilled context (summary +
 *   recent turns) suitable for splicing into a system prompt.
 * - `remember` stores the agent's text and tool-call events into the
 *   peer's session log. Background derivers update the peer's
 *   psychological representation; subsequent `recall` calls see it.
 *
 * Honcho's derivers run async — a `remember()` immediately followed
 * by a `recall()` may not see the fresh content. Treat reads as
 * eventually consistent.
 */
function createHonchoProvider(honcho: Honcho): MemoryProvider {
  return {
    async recall(scope: MemoryScope, query?: string): Promise<string> {
      try {
        const peer = await honcho.peer(scope.userId);
        // Honcho's .chat() returns a reasoning-grounded response with
        // the peer's prior representation baked in.
        const response = await peer.chat(
          query ?? 'Summarize what you know about this peer for context.',
        );
        return typeof response === 'string' ? response : String(response ?? '');
      } catch {
        // First-run users have no representation yet. Empty string is
        // a safe no-op for system-prompt splicing.
        return '';
      }
    },

    async remember(scope: MemoryScope, events: ReadonlyArray<AgentEvent>): Promise<void> {
      const sessionId = scope.sessionId ?? `tp-${Date.now()}`;
      const session = await honcho.session(sessionId);
      const peer = await honcho.peer(scope.userId);

      // Flatten thread-phase events into messages Honcho can index.
      // Use turn_end's assembled assistantText when present (less noisy
      // than raw deltas); fall back to text events otherwise.
      const messages = [];
      let pendingText = '';
      for (const event of events) {
        if (event.type === 'text') {
          pendingText += event.delta;
        } else if (event.type === 'turn_end') {
          const text = event.assistantText || pendingText;
          if (text) messages.push(peer.message(text));
          pendingText = '';
        }
      }
      if (pendingText) {
        messages.push(peer.message(pendingText));
      }

      if (messages.length > 0) {
        await session.addMessages(messages);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface Ctx extends BasePipelineContext {
  userId: string;
  question: string;
  memoryContext?: string;
  answer?: string;
  capturedEvents?: AgentEvent[];
}

const config = loadInferenceConfig();
const client = createInferenceClient();
const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

function buildPipeline(memory: MemoryProvider): Phase<Ctx>[] {
  const recallPhase: Phase<Ctx> = {
    name: 'recall',
    async *run(ctx) {
      yield { type: 'phase', phase: 'recall', detail: 'fetching memory' };
      ctx.memoryContext = await memory.recall({ userId: ctx.userId }, ctx.question);
      yield {
        type: 'data',
        key: 'memoryContext',
        value: { length: ctx.memoryContext.length },
      };
    },
  };

  const answerPhase: Phase<Ctx> = {
    name: 'answer',
    async *run(ctx) {
      const question = requireCtx(ctx, 'question', 'answer');
      const memoryContext = requireCtx(ctx, 'memoryContext', 'answer');

      const systemPrompt = memoryContext
        ? `You are a helpful assistant. Context about the user:\n${memoryContext}\n\nAnswer their question.`
        : 'You are a helpful assistant.';

      // Capture events as we go so the remember phase has something to write.
      const events: AgentEvent[] = [];
      const messages: Message[] = [{ role: 'user', content: question }];

      const result = await runAgentWithTools(
        {
          name: 'answer',
          systemPrompt,
          model: config.defaultModel,
          tools: [],
          maxToolRounds: 1,
          maxTokens: 500,
        },
        messages,
        {
          client,
          toolExecutor: noTools,
          onStreamEvent: (e) => {
            // Coarse translation: collapse content_delta into a single
            // canonical text event when the run finishes. For a real
            // adapter you'd use TurnAccumulator; this example keeps it
            // small.
            if (e.type === 'content_delta') {
              events.push({ type: 'text', source: 'inference', delta: e.delta });
            }
          },
        } satisfies AgentRunnerOptions,
      );

      // Synthesize a turn_end so the Honcho binding has a clean message.
      events.push({
        type: 'turn_end',
        source: 'inference',
        assistantText: result.text,
        toolCallCount: 0,
      });

      ctx.answer = result.text;
      ctx.capturedEvents = events;
      yield { type: 'data', key: 'answer', value: { length: result.text.length } };
    },
  };

  const rememberPhase: Phase<Ctx> = {
    name: 'remember',
    async *run(ctx) {
      const events = requireCtx(ctx, 'capturedEvents', 'remember');
      yield { type: 'phase', phase: 'remember', detail: 'persisting to Honcho' };
      await memory.remember({ userId: ctx.userId }, events);
      yield { type: 'data', key: 'remembered', value: { events: events.length } };
    },
  };

  return [recallPhase, answerPhase, rememberPhase];
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = process.env.HONCHO_API_KEY;
  if (!apiKey) {
    console.error('HONCHO_API_KEY required. Sign up at https://app.honcho.dev.');
    process.exit(1);
  }

  const honcho = new Honcho({ apiKey, workspaceId: process.env.HONCHO_WORKSPACE_ID });
  const memory = createHonchoProvider(honcho);

  const ctx: Ctx = {
    cache: new PipelineCache(),
    userId: process.env.USER_ID ?? 'demo-user',
    question: process.argv.slice(2).join(' ') || 'What did we talk about last time?',
  };

  // Inline runPipeline rather than JobRunner so the example is short.
  // For production, wrap with JobRunner + SqliteJobStore as in the
  // canonical template in AGENTS.md.
  const { runPipeline } = await import('@autonome-research/thread-phase');
  for await (const event of runPipeline(buildPipeline(memory), ctx)) {
    if (event.type === 'phase') console.log(`[${event.phase}] ${event.detail ?? ''}`);
  }

  console.log('\n>', ctx.question);
  console.log('<', ctx.answer);
}

main().catch((err) => {
  console.error('error:', err);
  process.exit(1);
});
