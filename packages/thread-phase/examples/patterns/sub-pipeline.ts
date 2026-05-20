/**
 * subPipeline example — compose a reusable inner pipeline.
 *
 * Two scenarios in one file:
 *   1. "validate" pipeline is reused inside "ingest" via subPipeline pattern.
 *   2. The inner pipeline's `tally` is mapped back into the outer's ctx via
 *      mapOutput, demonstrating cross-pipeline state flow with isolation.
 *
 * Run: npx tsx examples/patterns/sub-pipeline.ts
 */

import {
  PipelineCache,
  runPipeline,
  type Phase,
  type BasePipelineContext,
} from '../../src/index.js';
import { subPipeline } from '../../src/patterns/index.js';

// --- inner pipeline: validate a payload, count fields --------------------

interface ValidateCtx extends BasePipelineContext {
  payload: { name?: string; age?: number };
  valid: boolean;
  fieldCount: number;
}

const checkRequired: Phase<ValidateCtx> = {
  name: 'check-required',
  async *run(ctx) {
    ctx.valid = typeof ctx.payload.name === 'string' && ctx.payload.name.length > 0;
    yield { type: 'data', key: 'valid', value: ctx.valid };
  },
};

const countFields: Phase<ValidateCtx> = {
  name: 'count-fields',
  async *run(ctx) {
    ctx.fieldCount = Object.keys(ctx.payload).length;
    yield { type: 'data', key: 'fieldCount', value: ctx.fieldCount };
  },
};

// --- outer pipeline: ingest, using validate as a sub-pipeline ------------

interface IngestCtx extends BasePipelineContext {
  raw: { name: string; age: number };
  validated: boolean;
  fields: number;
  stored: boolean;
}

const store: Phase<IngestCtx> = {
  name: 'store',
  async *run(ctx) {
    if (!ctx.validated) {
      ctx.stop = { reason: 'cannot store invalid payload' };
      return;
    }
    ctx.stored = true;
    yield { type: 'data', key: 'stored', value: { ...ctx.raw, fields: ctx.fields } };
  },
};

const ctx: IngestCtx = {
  cache: new PipelineCache(),
  raw: { name: 'Code4me2', age: 30 },
  validated: false,
  fields: 0,
  stored: false,
};

const phases: Phase<IngestCtx>[] = [
  subPipeline<IngestCtx, ValidateCtx>('validate', {
    pipeline: {
      phases: [checkRequired, countFields],
      ctx: {
        cache: new PipelineCache(),
        payload: {},
        valid: false,
        fieldCount: 0,
      },
    },
    mapInput: (outer) => ({
      cache: new PipelineCache(),
      payload: outer.raw,
      valid: false,
      fieldCount: 0,
    }),
    mapOutput: (outer, inner) => {
      outer.validated = inner.valid;
      outer.fields = inner.fieldCount;
    },
  }),
  store,
];

for await (const event of runPipeline(phases, ctx)) {
  console.log(JSON.stringify(event));
}

console.log('\nFinal outer ctx:', { validated: ctx.validated, fields: ctx.fields, stored: ctx.stored });
