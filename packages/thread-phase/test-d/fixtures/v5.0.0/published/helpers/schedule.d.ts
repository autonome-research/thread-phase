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
import type { Trigger, TriggerEvent } from '../triggers/types.js';
import type { ExtensionRegisterFn, HelperHandler } from './types.js';
export type ScheduleSpec = {
    intervalMs: number;
} | {
    cron: string;
};
export interface ScheduleOptions {
    /** Pipeline + trigger base name. Defaults to the calling file's basename. */
    name?: string;
    /** Free-form description for `thread-phase list`. */
    description?: string;
}
export declare function schedule<TResult = unknown>(spec: ScheduleSpec, handler: HelperHandler<TriggerEvent<unknown>, TResult>, options?: ScheduleOptions): ExtensionRegisterFn;
interface CronParserModule {
    parseExpression(expr: string): {
        next(): {
            toDate(): Date;
        };
    };
}
interface CronTriggerOptions {
    cron: string;
    name: string;
    /** Test-only seam: inject a cron-parser implementation. */
    _cronParser?: CronParserModule;
}
export declare class CronTrigger implements Trigger<void> {
    readonly name: string;
    private readonly cron;
    private readonly injected?;
    private seq;
    private stopped;
    private pendingTimer;
    private notifyStop;
    constructor(opts: CronTriggerOptions);
    start(): AsyncGenerator<TriggerEvent<void>, void>;
    stop(): Promise<void>;
    private waitOrStop;
}
export {};
//# sourceMappingURL=schedule.d.ts.map