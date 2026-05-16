/**
 * Codex adapter entry. In-process; uses the OpenAI SDK's Responses API
 * (the same surface the Codex CLI wraps). Requires OPENAI_API_KEY or a
 * pre-built client passed in config.
 *
 * @internal
 */

export { codexAgent, type CodexAgentConfig } from './adapter.js';
