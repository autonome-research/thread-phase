/**
 * OpenClaw adapter — wraps the ACP chassis to talk to OpenClaw via `acpx`.
 *
 * OpenClaw itself runs as a Gateway daemon (default :18789); `acpx` is the
 * companion ACP client that bridges the Gateway. The adapter spawns `acpx`
 * and lets the chassis handle the protocol.
 *
 * The Gateway must be running before the adapter is invoked. If it isn't,
 * `acpx` exits early and the adapter surfaces the subprocess stderr as a
 * `native { kind: 'acp:stderr' }` event followed by `finishReason: 'error'`.
 *
 * NemoClaw mode: NemoClaw is NVIDIA's sandboxing layer that runs OpenClaw
 * inside an isolated environment. Setting `sandbox: 'nemoclaw'` invokes the
 * chassis command via `nemoclaw connect`, which routes IO through the
 * sandbox. Requires NemoClaw to be installed and onboarded.
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
export interface OpenClawAgentConfig {
  /** Working directory advertised to OpenClaw at session/new. */
  cwd: string;
  /** Prompt sent via session/prompt. */
  prompt: string | ContentBlock[];
  /** Resume a prior OpenClaw session by its id. */
  resumeSessionId?: string;
  /** Path to the `acpx` executable; default 'acpx'. */
  openClawExecutable?: string;
  /** Extra args passed to acpx; default []. */
  openClawArgs?: string[];
  /**
   * Sandbox mode. 'local' (default) runs acpx directly. 'nemoclaw' invokes
   * the acpx command through `nemoclaw connect` so the agent runs inside
   * the NemoClaw OpenShell sandbox.
   */
  sandbox?: 'local' | 'nemoclaw';
  /** Executable for the NemoClaw CLI; default 'nemoclaw'. */
  nemoclawExecutable?: string;
  /** Environment overrides merged with process.env. */
  env?: Record<string, string>;
  /** MCP servers exposed to OpenClaw; default []. */
  mcpServers?: McpServer[];
  /** Permission handling for tool calls OpenClaw asks the client to authorize. */
  permissionMode?: AcpAgentConfig['permissionMode'];
  /** Cancel-then-SIGTERM grace window in ms; default 2000. */
  cancelGraceMs?: number;
  /** SIGTERM-then-SIGKILL grace window in ms; default 3000. */
  killGraceMs?: number;
}

const chassis = createAcpAdapter({ id: 'openclaw' });

function toAcpConfig(config: OpenClawAgentConfig): AcpAgentConfig {
  const acpx = config.openClawExecutable ?? 'acpx';
  const userArgs = config.openClawArgs ?? [];

  if (config.sandbox === 'nemoclaw') {
    const nemoclaw = config.nemoclawExecutable ?? 'nemoclaw';
    return {
      command: nemoclaw,
      args: ['connect', acpx, ...userArgs],
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

  return {
    command: acpx,
    args: userArgs,
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
export const openClawAgent: AgentAdapterMeta<OpenClawAgentConfig> = defineAgentAdapter({
  id: chassis.id,
  capabilities: chassis.capabilities,
  adapter: (config, options) => chassis.adapter(toAcpConfig(config), options),
});
