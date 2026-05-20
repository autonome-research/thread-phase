/**
 * bare-agent — the hello world.
 *
 * One tool, one user message, one agent run. Demonstrates the smallest
 * useful shape: register a tool with the registry, call runAgentWithTools,
 * inspect the structured result.
 *
 * Run:  npx tsx examples/bare-agent.ts
 *
 * Configure the inference endpoint via env vars (see .env.example):
 *   INFERENCE_BASE_URL  — default http://localhost:8000/v1
 *   INFERENCE_MODEL     — default qwen3.6-27b
 *   INFERENCE_API_KEY   — default not-needed-for-local-vllm
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
    name: 'add',
    description: 'Add two integers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First integer' },
        b: { type: 'number', description: 'Second integer' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  async (args) => String((args.a as number) + (args.b as number)),
);

const result = await runAgentWithTools(
  {
    name: 'math-agent',
    systemPrompt:
      'You are a calculator. Use the add tool when the user asks for arithmetic. After receiving the result, reply with just the number.',
    model: config.defaultModel,
    tools: tools.definitions(),
    maxToolRounds: 5,
    maxTokens: 256,
  },
  [{ role: 'user', content: 'What is 17 + 25?' }],
  { client, toolExecutor: tools },
);

console.log('text:           ', result.text.trim());
console.log('finishReason:   ', result.finishReason);
console.log('usage:          ', result.usage);
console.log('tools executed: ', result.executedToolCalls.length);
for (const tc of result.executedToolCalls) {
  console.log(`  - ${tc.name}(${JSON.stringify(tc.input)})`);
}
