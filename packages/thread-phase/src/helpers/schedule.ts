/**
 * `schedule` — register a recurring pipeline driven by a timer or cron.
 *
 * Two surface forms:
 *
 *   schedule({ intervalMs: N }, handler)  // fires every N ms
 *   schedule({ cron: expr }, handler)     // fires per cron expression
 *
 * Both register one Trigger (a `TimerTrigger` for `intervalMs`, a
 * `CronTrigger` for `cron`) and one Pipeline that binds to it. The
 * handler runs as a single Phase per fire; its return value is captured
 * as a `data` event `${name}.result`.
 *
 * The `cron` form lazy-loads the optional peer dependency `cron-parser`
 * at trigger start. Library users who never call the cron form pay
 * nothing for the dep.
 */

import { PipelineCache } from '../cache.js';
import type { BasePipelineContext, Phase } from '../phase.js';
import { TimerTrigger } from '../triggers/timer-trigger.js';
import type { Trigger, TriggerEvent } from '../triggers/types.js';
import { deriveNameFromCaller } from './caller.js';
import type {
  ExtensionRegisterFn,
  HelperHandler,
  PipelineSpec,
} from './types.js';

export type ScheduleSpec = { intervalMs: number } | { cron: string };

export interface ScheduleOptions {
  /** Pipeline + trigger base name. Defaults to the calling file's basename. */
  name?: string;
  /** Free-form description for `thread-phase list`. */
  description?: string;
}

export function schedule<TResult = unknown>(
  spec: ScheduleSpec,
  handler: HelperHandler<TriggerEvent<unknown>, TResult>,
  options: ScheduleOptions = {},
): ExtensionRegisterFn {
  const name = options.name ?? deriveNameFromCaller('schedule');
  const triggerName = `${name}:trigger`;

  let trigger: Trigger<unknown>;
  if ('intervalMs' in spec) {
    trigger = new TimerTrigger({
      intervalMs: spec.intervalMs,
      name: triggerName,
    });
  } else {
    trigger = new CronTrigger({ cron: spec.cron, name: triggerName });
  }

  const phase: Phase<BasePipelineContext> = {
    name,
    async *run(ctx) {
      const event = (ctx as { __triggerEvent?: TriggerEvent<unknown> })
        .__triggerEvent ?? {
        id: 0,
        occurredAt: new Date().toISOString(),
        input: undefined,
      };
      const result = await handler(event, ctx);
      yield {
        type: 'data',
        key: `${name}.result`,
        value: result,
      };
    },
  };

  const pipelineSpec: PipelineSpec<BasePipelineContext, unknown> = {
    phases: [phase],
    ctx: (_input, event) => {
      const ctx: BasePipelineContext & {
        __triggerEvent?: TriggerEvent<unknown>;
      } = { cache: new PipelineCache() };
      ctx.__triggerEvent = event;
      return ctx;
    },
    trigger: triggerName,
    description: options.description,
  };

  return (api) => {
    api.registerTrigger(triggerName, trigger);
    api.registerPipeline(name, pipelineSpec);
  };
}

// ---------------------------------------------------------------------------
// CronTrigger — lazy-loads `cron-parser` on start to compute the next fire
// delay. Reschedules itself via setTimeout per fire. Kept inside the
// schedule helper since it's an implementation detail of the cron form.
// ---------------------------------------------------------------------------

interface CronParserModule {
  parseExpression(expr: string): { next(): { toDate(): Date } };
}

interface CronTriggerOptions {
  cron: string;
  name: string;
  /** Test-only seam: inject a cron-parser implementation. */
  _cronParser?: CronParserModule;
}

export class CronTrigger implements Trigger<void> {
  readonly name: string;
  private readonly cron: string;
  private readonly injected?: CronParserModule;

  private seq = 0;
  private stopped = false;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyStop: (() => void) | null = null;

  constructor(opts: CronTriggerOptions) {
    this.name = opts.name;
    this.cron = opts.cron;
    this.injected = opts._cronParser;
  }

  async *start(): AsyncGenerator<TriggerEvent<void>, void> {
    if (this.stopped) return;
    const parser =
      this.injected ??
      ((await import('cron-parser' as string)) as unknown as CronParserModule);

    while (!this.stopped) {
      const next = parser.parseExpression(this.cron).next().toDate();
      const delay = Math.max(0, next.getTime() - Date.now());
      const waited = await this.waitOrStop(delay);
      if (!waited) return;
      yield {
        id: ++this.seq,
        occurredAt: new Date().toISOString(),
        input: undefined as void,
      };
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.notifyStop?.();
    this.notifyStop = null;
  }

  private waitOrStop(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        resolve(true);
      }, ms);
      this.notifyStop = () => resolve(false);
    });
  }
}
