/**
 * Pre-built `inject` callbacks for `withMemory` and `withThread`.
 *
 * Both wrappers in `thread-phase/agents` take a caller-supplied
 * `inject` function because each adapter shapes its prompt field
 * differently — `inferenceAgent` puts it on `config.config.systemPrompt`,
 * Anthropic uses `systemPrompt`, Codex uses `instructions`, ACP-based
 * adapters use `config.prompt`. Writing the right splicer at every
 * call site is friction; these tables ship the canonical ones for the
 * bundled adapter set.
 *
 * Composes with `withMemory` / `withThread`:
 *
 *     const memoryAware = withMemory(claudeCodeAgent, {
 *       scope: { userId: 'alice' },
 *       inject: injectMemory.claudeCode,
 *     });
 *
 *     const threadAware = withThread(hermesAgent, thread, {
 *       applyResume: injectResume.hermes,
 *     });
 *
 * The keys match each adapter's public id (`'claude-code'` → `claudeCode`
 * etc., camelCased for TypeScript ergonomics).
 *
 * @internal
 */

import type {
  InferenceAgentConfig,
  ResumeToken,
} from 'thread-phase/agents';

import type { AcpAgentConfig } from './acp/index.js';
import type { AnthropicAgentConfig } from './anthropic/index.js';
import type { ClaudeCodeAgentConfig } from './claude-code/index.js';
import type { CodexAgentConfig } from './codex/index.js';
import type { HermesAgentConfig } from './hermes/index.js';
import type { OpenClawAgentConfig } from './openclaw/index.js';

// ---------------------------------------------------------------------------
// Memory injectors
// ---------------------------------------------------------------------------

const MEMORY_HEADER = '\n\nContext from prior interactions:\n';

/** @internal */
export const injectMemory = {
  /**
   * Append memory to the agent runner's system prompt. Leaves config
   * unchanged when memory is empty (first-run users with no recall).
   */
  inference(cfg: InferenceAgentConfig, memory: string): InferenceAgentConfig {
    if (!memory) return cfg;
    return {
      ...cfg,
      config: {
        ...cfg.config,
        systemPrompt: `${cfg.config.systemPrompt}${MEMORY_HEADER}${memory}`,
      },
    };
  },

  /** Append memory to Anthropic's system prompt. */
  anthropic(cfg: AnthropicAgentConfig, memory: string): AnthropicAgentConfig {
    if (!memory) return cfg;
    return {
      ...cfg,
      systemPrompt: `${cfg.systemPrompt ?? ''}${MEMORY_HEADER}${memory}`,
    };
  },

  /** Append memory to Codex's `instructions` (Responses API system equivalent). */
  codex(cfg: CodexAgentConfig, memory: string): CodexAgentConfig {
    if (!memory) return cfg;
    return {
      ...cfg,
      instructions: `${cfg.instructions ?? ''}${MEMORY_HEADER}${memory}`,
    };
  },

  /**
   * Prepend memory to Claude Code's prompt. Claude Code's CLI has no
   * separate system-prompt flag at this layer, so memory becomes part
   * of the user prompt.
   */
  claudeCode(cfg: ClaudeCodeAgentConfig, memory: string): ClaudeCodeAgentConfig {
    if (!memory) return cfg;
    return {
      ...cfg,
      prompt: `Context from prior interactions:\n${memory}\n\nCurrent request: ${cfg.prompt}`,
    };
  },

  /**
   * Prepend memory to the ACP prompt. ACP's `session/prompt` has no
   * system slot — memory becomes part of the user message content.
   * Preserves a non-text prompt (ContentBlock[]) by injecting the
   * memory as a leading text block.
   */
  acp(cfg: AcpAgentConfig, memory: string): AcpAgentConfig {
    if (!memory) return cfg;
    if (Array.isArray(cfg.prompt)) {
      return {
        ...cfg,
        prompt: [{ type: 'text', text: `Context from prior interactions:\n${memory}\n\n` }, ...cfg.prompt],
      };
    }
    return {
      ...cfg,
      prompt: `Context from prior interactions:\n${memory}\n\nCurrent request: ${cfg.prompt}`,
    };
  },

  /** Same shape as `acp` — Hermes is an ACP wrapper. */
  hermes(cfg: HermesAgentConfig, memory: string): HermesAgentConfig {
    if (!memory) return cfg;
    if (Array.isArray(cfg.prompt)) {
      return {
        ...cfg,
        prompt: [{ type: 'text', text: `Context from prior interactions:\n${memory}\n\n` }, ...cfg.prompt],
      };
    }
    return {
      ...cfg,
      prompt: `Context from prior interactions:\n${memory}\n\nCurrent request: ${cfg.prompt}`,
    };
  },

  /** Same shape as `acp` — OpenClaw is an ACP wrapper. */
  openClaw(cfg: OpenClawAgentConfig, memory: string): OpenClawAgentConfig {
    if (!memory) return cfg;
    if (Array.isArray(cfg.prompt)) {
      return {
        ...cfg,
        prompt: [{ type: 'text', text: `Context from prior interactions:\n${memory}\n\n` }, ...cfg.prompt],
      };
    }
    return {
      ...cfg,
      prompt: `Context from prior interactions:\n${memory}\n\nCurrent request: ${cfg.prompt}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Resume injectors
// ---------------------------------------------------------------------------

/** @internal */
export const injectResume = {
  /** inferenceAgent declares `resumption: 'none'`; passthrough. */
  inference(cfg: InferenceAgentConfig, _token: ResumeToken): InferenceAgentConfig {
    return cfg;
  },

  /** anthropicAgent declares `resumption: 'none'`; passthrough. */
  anthropic(cfg: AnthropicAgentConfig, _token: ResumeToken): AnthropicAgentConfig {
    return cfg;
  },

  /** Codex's Responses API takes `previous_response_id` natively. */
  codex(cfg: CodexAgentConfig, token: ResumeToken): CodexAgentConfig {
    if (token.kind !== 'response-id') return cfg;
    return { ...cfg, previousResponseId: token.id };
  },

  /** Claude Code's CLI takes `--resume <session-id>`. */
  claudeCode(cfg: ClaudeCodeAgentConfig, token: ResumeToken): ClaudeCodeAgentConfig {
    if (token.kind !== 'opaque') return cfg;
    return { ...cfg, resumeSessionId: token.data };
  },

  /** ACP's `session/load` takes a session id. */
  acp(cfg: AcpAgentConfig, token: ResumeToken): AcpAgentConfig {
    if (token.kind !== 'opaque') return cfg;
    return { ...cfg, resumeSessionId: token.data };
  },

  /** Hermes inherits ACP's resume path. */
  hermes(cfg: HermesAgentConfig, token: ResumeToken): HermesAgentConfig {
    if (token.kind !== 'opaque') return cfg;
    return { ...cfg, resumeSessionId: token.data };
  },

  /** OpenClaw inherits ACP's resume path. */
  openClaw(cfg: OpenClawAgentConfig, token: ResumeToken): OpenClawAgentConfig {
    if (token.kind !== 'opaque') return cfg;
    return { ...cfg, resumeSessionId: token.data };
  },
};
