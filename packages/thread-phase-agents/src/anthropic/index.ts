/**
 * Anthropic adapter entry. In-process; requires @anthropic-ai/sdk and a
 * valid ANTHROPIC_API_KEY (or a pre-built client passed in config).
 *
 * @internal
 */

export { anthropicAgent, type AnthropicAgentConfig } from './adapter.js';
