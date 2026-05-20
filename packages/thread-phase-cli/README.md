# @autonome-research/thread-phase-cli

The CLI and auto-loader for [thread-phase](https://github.com/Code4me2/thread-phase). Discovers extensions under `./.thread-phase/{triggers,adapters,pipelines}/` and runs registered pipelines.

```sh
npm install -g @autonome-research/thread-phase-cli @autonome-research/thread-phase
```

## Commands

```sh
thread-phase list                    # show registered extensions
thread-phase run <pipeline-name>     # invoke a pipeline once and exit
thread-phase serve                   # start all triggered pipelines (SIGINT/SIGTERM to stop)
```

`run` replaces `npx tsx pipelines/foo.ts` once the pipeline is registered. `serve` is the systemd-unit / docker-container case — one long-running process per project hosting every triggered pipeline.

## Extension layout

```
your-project/
  .thread-phase/
    triggers/<name>.ts       a Trigger registered via api.registerTrigger
    adapters/<name>.ts       an AgentAdapter registered via api.registerAdapter
    pipelines/<name>.ts      a Pipeline registered via api.registerPipeline
```

Each file's default export is `(api: ThreadPhaseAPI) => void`. See [`EXTENDING.md`](../../EXTENDING.md) for the full contract, three-tier discovery (loose file → folder → package.json manifest), and copy-paste templates.

## Programmatic API

```ts
import { Registry, loadExtensions, runCli } from '@autonome-research/thread-phase-cli';

const registry = new Registry();
await loadExtensions(registry, { cwd: process.cwd() });

const pipelines = registry.listPipelines();
// or invoke the full CLI dispatch:
const code = await runCli({ args: ['run', 'morning-digest'] });
```

Useful for embedding the loader inside a larger runtime (a job queue worker, a Temporal activity, a custom server).

## Stability

Versions are locked across the thread-phase monorepo. CLI 2.x.x ships against thread-phase 2.x.x.
