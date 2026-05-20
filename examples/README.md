# thread-phase examples — the corpus

This tree is the **canonical corpus** an agent reads to learn how to extend thread-phase. It mirrors the layout the auto-loader expects.

## Tree

```
examples/
  .thread-phase/
    triggers/morning-timer.ts          ← register a Trigger by name
    adapters/claude-with-flags.ts      ← register a custom AgentAdapter by name
    lib/poll-until.ts                  ← shared user-side pattern (not auto-loaded)
    pipelines/
      minimal.ts                       ← one-shot pipeline, literal ctx
      morning-digest.ts                ← triggered pipeline, factory ctx, uses boundedFanout
      heterogeneous-chain.ts           ← claude-code → codex → anthropic via Thread
      poll-job.ts                      ← imports pollUntil from ../lib/ (shared-code convention)
```

Plus per-package examples that exercise core/agents without the CLI:

- `packages/thread-phase/examples/` — library-only patterns (`bare-agent`, `bounded-fanout`, `multi-phase-pipeline`, `sse-server`, `agent-authored-cron`, `honcho-memory`, `streaming-consumer`, `smoke`)
- `packages/thread-phase/examples/patterns/` — `while-condition`, `match`, `with-retry`
- `packages/thread-phase/examples/triggers/` — `timer-basic`, `timer-with-job-runner`, `http-adapt`, `queue-adapt`

## Running these

```sh
cd examples
npx thread-phase list
npx thread-phase run minimal
npx thread-phase serve     # fires morning-digest on morning-timer
```

For library-only examples (no CLI):

```sh
cd packages/thread-phase
npx tsx examples/bare-agent.ts
npx tsx examples/patterns/while-condition.ts
```

## How to add your own

Drop a file into the appropriate `.thread-phase/<kind>/` directory with a default export `(api: ThreadPhaseAPI) => void`. See [`EXTENDING.md`](../EXTENDING.md) for the full contract and discovery rules.
