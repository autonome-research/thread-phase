/**
 * streaming-consumer — print content + tool-call lifecycle as they arrive.
 *
 * Demonstrates the onStreamEvent callback. The agent has one tool; you'll
 * see content deltas stream in as the model produces them, then a
 * tool-call lifecycle (start → execute → complete), then more content
 * streaming for the final answer.
 *
 * Run:  npx tsx examples/streaming-consumer.ts
 */

import {
  runAgentWithTools,
  ToolRegistry,
  createInferenceClient,
  loadInferenceConfig,
} from '../src/index.js';

const config = loadInferenceConfig();
const client = createInferenceClient();

const tools = new ToolRegistry().register(
  {
    name: 'lookup_population',
    description: 'Look up the population of a city.',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
  async (args) => {
    // Simulate I/O latency.
    await new Promise((r) => setTimeout(r, 200));
    const populations: Record<string, string> = {
      tokyo: '13,960,000',
      paris: '2,148,000',
      lagos: '15,388,000',
    };
    const city = String(args.city ?? '').toLowerCase();
    return populations[city] ?? 'unknown';
  },
);

process.stdout.write('Streaming agent output:\n\n');

const result = await runAgentWithTools(
  {
    name: 'pop-agent',
    systemPrompt:
      'You are a geography assistant. Use lookup_population for questions about city populations. Reply briefly.',
    model: config.defaultModel,
    tools: tools.definitions(),
    maxToolRounds: 5,
    maxTokens: 400,
  },
  [{ role: 'user', content: 'What is the population of Lagos?' }],
  {
    client,
    toolExecutor: tools,
    onStreamEvent: (event) => {
      switch (event.type) {
        case 'content_delta':
          process.stdout.write(event.delta);
          break;
        case 'tool_call_started':
          process.stdout.write(
            `\n  [tool started] ${event.toolCall.name}(${JSON.stringify(event.toolCall.input)})\n`,
          );
          break;
        case 'tool_call_complete':
          process.stdout.write(
            `  [tool result]  ${event.result.content.slice(0, 80)}\n\n`,
          );
          break;
        case 'round_complete':
          process.stdout.write(
            `\n  [round ${event.round} done — finishReason=${event.finishReason}]\n`,
          );
          break;
      }
    },
  },
);

console.log('\n\n--- final ---');
console.log('finishReason:   ', result.finishReason);
console.log('usage:          ', result.usage);
console.log('tools executed: ', result.executedToolCalls.length);
