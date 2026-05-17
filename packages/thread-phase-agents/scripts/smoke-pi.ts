/**
 * Real-binary smoke test for `piAgent`.
 *
 * Runs in-process via `@mariozechner/pi-coding-agent`. Pi auto-discovers
 * its model from `~/.pi/agent/settings.json` and providers from
 * `~/.pi/agent/models.json` — typical setup uses a local vLLM/Ollama or
 * a configured cloud provider.
 *
 * Run:
 *   npx tsx scripts/smoke-pi.ts [prompt]
 */

import { piAgent } from '../src/pi/index.js';
import { isSteerable } from 'thread-phase/agents';

async function main(): Promise<void> {
  const cwd = process.cwd();
  const prompt = process.argv.slice(2).join(' ') || "Reply with only the word: hello";

  console.log(`[smoke] piAgent — cwd=${cwd}`);
  console.log(`[smoke] prompt: ${prompt}\n`);

  const run = piAgent.adapter({ cwd, prompt });
  console.log(`[smoke] isSteerable: ${isSteerable(run)}`);

  const nativeKinds = new Map<string, number>();
  let textBuf = '';
  let agentStart = false;
  let agentEnd = false;
  let thinking = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let turnEnds = 0;

  const start = Date.now();
  for await (const event of run.events) {
    switch (event.type) {
      case 'agent_start':
        agentStart = true;
        console.log(`[smoke] agent_start  resumeToken=${JSON.stringify(event.resumeToken ?? null)}`);
        break;
      case 'text':
        textBuf += event.delta;
        process.stdout.write(`[text] ${event.delta}\n`);
        break;
      case 'thinking':
        thinking += 1;
        process.stdout.write(`[thinking] ${event.delta.slice(0, 80)}\n`);
        break;
      case 'tool_call':
        toolCalls += 1;
        console.log(`[tool_call] ${event.name}  input=${JSON.stringify(event.input).slice(0, 80)}`);
        break;
      case 'tool_result':
        toolResults += 1;
        console.log(`[tool_result] ${event.name}  isError=${event.isError}`);
        break;
      case 'turn_end':
        turnEnds += 1;
        console.log(`[turn_end] assistantText=${event.assistantText.length} chars  toolCalls=${event.toolCallCount}  usage=${JSON.stringify(event.usage ?? null)}`);
        break;
      case 'native':
        nativeKinds.set(event.kind, (nativeKinds.get(event.kind) ?? 0) + 1);
        break;
      case 'error':
        console.log(`[error] ${event.error.name}: ${event.error.message}`);
        break;
      case 'agent_end':
        agentEnd = true;
        console.log(`[smoke] agent_end  reason=${event.reason}  resumeToken=${JSON.stringify(event.resumeToken ?? null)}`);
        break;
    }
  }

  const result = await run.result;
  const elapsed = Date.now() - start;

  console.log('\n[smoke] === summary ===');
  console.log(`  duration:        ${elapsed}ms`);
  console.log(`  finishReason:    ${result.finishReason}`);
  console.log(`  text length:     ${result.text.length} (streamed: ${textBuf.length})`);
  console.log(`  usage:           in=${result.usage.promptTokens} out=${result.usage.completionTokens}`);
  console.log(`  agent_start:     ${agentStart}`);
  console.log(`  agent_end:       ${agentEnd}`);
  console.log(`  thinking:        ${thinking}`);
  console.log(`  tool_calls:      ${toolCalls}`);
  console.log(`  tool_results:    ${toolResults}`);
  console.log(`  turn_ends:       ${turnEnds}`);
  console.log(`  executedTools:   ${result.executedToolCalls.length}`);
  console.log(`  resumeToken:     ${JSON.stringify(result.resumeToken ?? null)}`);
  if (nativeKinds.size > 0) {
    console.log('  native event kinds:');
    for (const [kind, count] of nativeKinds) {
      console.log(`    ${kind}: ${count}`);
    }
  }

  const passed =
    agentStart &&
    agentEnd &&
    (result.finishReason === 'stop' || result.finishReason === 'tool_calls') &&
    result.text.length > 0;

  console.log(`\n[smoke] result: ${passed ? 'PASS' : 'FAIL'}`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] unhandled error:', err);
  process.exit(2);
});
