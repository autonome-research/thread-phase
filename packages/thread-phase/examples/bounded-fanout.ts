/**
 * bounded-fanout — per-item agent over a list, concurrency-capped.
 *
 * The canonical batch shape. We have a list of items and want to run an
 * agent on each, but the inference backend has a hard concurrency cap
 * (e.g. vLLM's --max-num-seqs). boundedFanout matches concurrency to that
 * bottleneck and surfaces per-item completion via the optional
 * onItemDone callback.
 *
 * Run:  npx tsx examples/bounded-fanout.ts
 */

import {
  runAgentWithTools,
  createInferenceClient,
  loadInferenceConfig,
  parseJSON,
  type ToolExecutor,
} from '../src/index.js';
import { boundedFanout } from '../src/patterns/index.js';

const config = loadInferenceConfig();
const client = createInferenceClient();
const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

const SENTENCES = [
  'The cat sat on the mat.',
  'Quantum entanglement is a phenomenon in particle physics.',
  'I would prefer not to.',
  'All happy families are alike.',
  'The mitochondrion is the powerhouse of the cell.',
  'Call me Ishmael.',
];

interface Classification {
  category: 'literary' | 'scientific' | 'other';
  confidence: number;
}

const start = Date.now();

const results = await boundedFanout({
  items: SENTENCES,
  concurrency: 3, // match your backend's max-num-seqs
  runner: async (sentence, i): Promise<Classification> => {
    const r = await runAgentWithTools(
      {
        name: `classifier-${i}`,
        systemPrompt:
          'Classify the sentence. Reply ONLY as JSON: {"category": "literary"|"scientific"|"other", "confidence": 0.0-1.0}.',
        model: config.defaultModel,
        tools: [],
        maxToolRounds: 1,
        maxTokens: 80,
      },
      [{ role: 'user', content: sentence }],
      { client, toolExecutor: noTools },
    );
    return parseJSON<Classification>(r.text, { category: 'other', confidence: 0 });
  },
  onItemDone: ({ index, result }) => {
    console.log(
      `  [${index}] ${result.category.padEnd(10)} (${result.confidence.toFixed(2)})  "${SENTENCES[index]}"`,
    );
  },
});

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nProcessed ${results.length} sentences in ${elapsed}s (concurrency=3)`);
console.log('\nResults preserve input order:');
for (let i = 0; i < results.length; i++) {
  console.log(`  ${i}: ${results[i]!.category}`);
}
