# @autonome-research/thread-phase-cli

The CLI and auto-loader for [thread-phase](https://github.com/autonome-research/thread-phase). Discovers extensions under `./.thread-phase/{triggers,adapters,pipelines}/` and runs registered pipelines.

```sh
# One install gets the full runtime — core + adapter protocol + bin.
npm install -g @autonome-research/thread-phase-cli

# …plus the agent SDKs your adapters actually use (optional, only when needed):
npm install -g @anthropic-ai/sdk                # anthropicAgent
npm install -g openai                           # codexAgent (Responses API)
npm install -g @earendil-works/pi-coding-agent    # piAgent (Node.js >=22.19.0)
```

## Commands

```sh
thread-phase list                    # show registered extensions
thread-phase list --verbose          # …plus structural details per entry
thread-phase run <pipeline-name>     # invoke a pipeline once and exit
thread-phase run <name> --input ...  # override defaultInput (JSON literal, @file, or -)
thread-phase serve                   # start all triggered pipelines (SIGINT/SIGTERM to stop)
thread-phase serve --health-port N   # …with a /health endpoint on port N
```

`run` replaces `npx tsx pipelines/foo.ts` once the pipeline is registered. `serve` is the systemd-unit / docker-container case — one long-running process per project hosting every triggered pipeline.

### `run --input`

Three forms for supplying input that overrides the pipeline's `defaultInput`:

```sh
thread-phase run digest --input '{"date":"2026-05-20"}'  # inline JSON
thread-phase run digest --input @./payload.json          # read JSON from file
echo '{"date":"2026-05-20"}' | thread-phase run digest --input -  # read from stdin
```

Invalid JSON or unreadable files exit 1 with a clear stderr message.

### `serve --health-port`

Opt-in health endpoint backed by `node:http`. While the serve loop is running it returns `200 {"status":"ok"}`. Once a shutdown signal arrives but pipelines are still draining it returns `503 {"status":"shutting_down"}`. The server stops listening when serve fully exits. Useful for k8s liveness/readiness probes or load-balancer drain checks.

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
