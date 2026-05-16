/**
 * Hermes adapter — wraps the ACP chassis to talk to `hermes acp`.
 *
 * Hermes ships an ACP-native server entry point (`hermes acp`), so the
 * adapter is a thin configuration layer over `createAcpAdapter({ id: 'hermes' })`
 * with sensible defaults for the executable and arguments.
 *
 * Requirements:
 *   - `hermes` binary installed and in PATH (or override via `hermesExecutable`)
 *   - Hermes configured with an OpenAI-compatible inference endpoint
 *
 * Session state persists in `~/.hermes/state.db`; resumption is via
 * Hermes session ids, exposed by the chassis as
 * `ResumeToken{ kind: 'opaque' }`.
 *
 * @internal
 */

import { defineAgentAdapter, type AgentAdapterMeta } from 'thread-phase/agents';
import {
  createAcpAdapter,
  type AcpAgentConfig,
  type ContentBlock,
  type McpServer,
} from '../acp/index.js';

/** @internal */
export interface HermesAgentConfig {
  /** Working directory advertised to Hermes at session/new. */
  cwd: string;
  /** Prompt sent via session/prompt. Strings become a single text block. */
  prompt: string | ContentBlock[];
  /** Resume a prior Hermes session by its id. */
  resumeSessionId?: string;
  /** Executable name; default 'hermes'. */
  hermesExecutable?: string;
  /**
   * Full args list passed to the executable. Default `['acp']` so the
   * standard `hermes acp` invocation works out of the box. Override
   * when running a different subcommand or when the executable is not
   * the `hermes` binary (tests using a stub, custom wrappers, etc.).
   */
  hermesArgs?: string[];
  /** Environment overrides merged with process.env. */
  env?: Record<string, string>;
  /** MCP servers exposed to Hermes; default []. */
  mcpServers?: McpServer[];
  /** Permission handling for tool calls Hermes asks the client to authorize. */
  permissionMode?: AcpAgentConfig['permissionMode'];
  /** Cancel-then-SIGTERM grace window in ms; default 2000. */
  cancelGraceMs?: number;
  /** SIGTERM-then-SIGKILL grace window in ms; default 3000. */
  killGraceMs?: number;
}

const chassis = createAcpAdapter({ id: 'hermes' });

function toAcpConfig(config: HermesAgentConfig): AcpAgentConfig {
  const executable = config.hermesExecutable ?? 'hermes';
  return {
    command: executable,
    args: config.hermesArgs ?? ['acp'],
    cwd: config.cwd,
    prompt: config.prompt,
    resumeSessionId: config.resumeSessionId,
    env: config.env,
    mcpServers: config.mcpServers,
    permissionMode: config.permissionMode,
    cancelGraceMs: config.cancelGraceMs,
    killGraceMs: config.killGraceMs,
    clientInfo: { name: 'thread-phase-agents', version: '0.0.1' },
  };
}

/** @internal */
export const hermesAgent: AgentAdapterMeta<HermesAgentConfig> = defineAgentAdapter({
  id: chassis.id,
  capabilities: chassis.capabilities,
  adapter: (config, options) => chassis.adapter(toAcpConfig(config), options),
});
