/**
 * Codex CLI adapter entry. Subprocess wrapper around `codex exec --json`.
 * Uses codex's own auth (ChatGPT OAuth or API key, whichever's configured
 * via `codex login`). For API-key-only callers, see `codexAgent` (the
 * in-process OpenAI Responses API adapter).
 *
 * @internal
 */

export { codexCliAgent, type CodexCliAgentConfig } from './adapter.js';
