# Contributing to thread-phase

Issues and PRs are welcome. The framework has a deliberately narrow scope — see [ROADMAP.md](./ROADMAP.md) for what's in, what's deferred, and what's explicitly out of scope. Reading that first will save you time on PRs that won't land.

## Reporting issues

Open a GitHub issue. Useful info:

- Node version (`node --version`)
- thread-phase version
- Inference backend (vLLM / Ollama / OpenAI / llama.cpp / other)
- Model name, if relevant
- Minimal reproduction (10-30 lines preferred)
- What you expected vs. what happened

If you hit a parser mismatch (model returns tool calls as plain content), check that your inference backend has the right `--tool-call-parser` first — that's almost always the cause.

## Pull requests

For **small fixes** (typos, single-bug fixes, test additions), open a PR directly.

For **anything larger** (new pattern, new public API, behavior change, dependency change), please **open an issue first** so we can discuss scope. We'd rather talk before code is written than ask you to revert.

### Checks that must pass

- `npm run typecheck` — TypeScript compiles cleanly
- `npm test` — full vitest suite passes
- New public API has tests covering the documented behavior
- New patterns include a "when not to use" docstring (existing patterns are good models)

### Style

Match what's already there. Specifically:

- **Phase docstrings** lead with the shape captured, then "when to use," then "when not to use."
- **Comments are sparse** and explain *why*, not *what*. If a comment would just narrate code that's clear from reading it, leave it out.
- **No emojis in code or docs** unless explicitly part of formatted output.
- **TypeScript strictness** stays at current level — no loosening.
- **Internal helpers** are marked `@internal` in JSDoc rather than not-exported. They're reachable for advanced callers but not covered by semver.

### Scope guardrails

We're unlikely to merge:

- A node/edge graph framework. The array-of-phases model is intentional — if you need a real DAG, the recommended pattern is to compose thread-phase under Temporal/LangGraph/Inngest.
- An Anthropic native SDK adapter. thread-phase is OpenAI-compatible by design.
- Multi-modal content blocks. Defer until a real consumer needs it.
- Built-in observability (OpenTelemetry, Prometheus). The activity log + `onStreamEvent` callback give you everything to wire it yourself.
- Dependencies beyond what's already in `package.json` — every new dep is a maintenance liability.

## Versioning

Once v1.0.0 ships, the project follows semver:

- **patch (1.0.x)** — bug fixes, no API changes
- **minor (1.x.0)** — additive only — new exports, new optional fields, new patterns
- **major (x.0.0)** — breaking changes

`@internal` exports are excluded from the stability commitment. Pin the minor version if you depend on them.

## License

By contributing, you agree your contribution will be licensed under the same MIT license as the project. There's no CLA.
