# Cancellation

thread-phase has one cancellation primitive — `AbortSignal` — surfaced at four layers, in order from outermost to innermost:

```
RunTriggerHandle.cancel(eventId)
        │
        ▼  aborts the dispatch's AbortController
JobRunner.cancel(jobId)
        │
        ▼  signal flows to phase code
ctx.signal  (passed to runAgentWithTools, etc.)
        │
        ▼  forwarded into adapter calls
AgentRun.abort(reason?)
```

Same signal underneath. Different names because each layer caches a reference to it for ergonomic access.

## Choosing the right layer

| You have | You want to cancel | Call |
|---|---|---|
| A `RunTriggerHandle` from `runTrigger` | One specific in-flight pipeline by its trigger event id | `handle.cancel(triggerEventId)` |
| A `JobRunner` reference + a `jobId` | One specific in-flight pipeline by its job id | `runner.cancel(jobId, reason?)` |
| A `Phase` body that calls `runAgentWithTools` | The currently-running inference call | Pass `{ signal: ctx.signal }` to `runAgentWithTools` |
| An `AgentAdapter` invocation in flight | Cooperative abort of the underlying agent | `run.abort(reason?)` on the `AgentRun` |
| External signal (SIGINT, controller from outside) | Stop the whole trigger loop + drain | `controller.abort(); await handle.stop();` |

## Propagation rules

- **`RunTriggerHandle.cancel(eventId)`** aborts the per-event AbortController. In `JobRunner` mode, this is wired to `jobRunner.cancel(jobId)`. In inline mode, it aborts the controller passed to `runPipelineToSummary`.
- **`JobRunner.cancel(jobId)`** aborts the per-job AbortController. The pipeline's `ctx.signal` (which `JobRunner` populates) flips to aborted. Phases observing `ctx.signal` see it immediately; phases between iterations see it on the next phase boundary via `runPipeline`'s pre-phase check.
- **`runPipeline`** checks `options.signal` between phases and throws `AbortError` if aborted. Mid-phase work is the phase's responsibility — observe `ctx.signal` or pass it into your async calls.
- **`runAgentWithTools`** honors `options.signal` by aborting the OpenAI stream. The signal flows from `ctx.signal` if you pass it explicitly.
- **`AgentRun.abort()`** aborts the underlying adapter run. Each adapter handles this differently (subprocess kill, SDK cancel, etc.).

## What gets persisted

When cancellation happens during a `JobRunner.run`:
1. `runner.cancel(jobId, reason)` aborts the controller
2. `JobRunner` catches the AbortError, calls `store.setFailed(jobId, "cancelled: <reason>")`
3. A synthesized `{ type: 'error', message: "cancelled: <reason>" }` event is appended to the event log
4. `runner.run()` rejects with the AbortError (`err.name === 'AbortError'`)

Live `job:${jobId}` subscribers see the synthesized error event before the promise rejection.

## Caveats

- **Between-phase cancellation only by default.** `runPipeline` checks the signal between phases. Within a phase, the phase must observe `ctx.signal` itself.
- **Cancellation reasons are strings, not Errors.** When you call `runner.cancel(jobId, 'user-stop')`, the resulting AbortError's message is `"cancelled: user-stop"`.
- **`handle.cancel(eventId)` returns false if the pipeline already completed.** Idempotent.
- **`handle.stop()` is NOT the same as cancelling all pipelines.** It stops the trigger from producing new events and waits for in-flight pipelines to drain naturally. To cancel everything in flight, iterate `handle.cancel(...)` first, then `await handle.stop()`.
