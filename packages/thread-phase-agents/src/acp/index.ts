/**
 * Agent Client Protocol chassis. Public entry for the ACP-speaking adapter
 * surface. Sibling adapters in this package (hermes, openclaw) call
 * `createAcpAdapter({ id })` to mint their own AgentAdapterMeta with the
 * right `source` field on every event.
 *
 * @internal
 */

export { acpAgent, createAcpAdapter, JsonRpcCallError } from './adapter.js';
export type { AcpAgentConfig, CreateAcpAdapterOptions } from './adapter.js';

// Types are exported so wrappers and callers can build typed configs.
export type {
  AgentCapabilities as AcpAgentCapabilities,
  AuthMethod,
  ClientCapabilities,
  ContentBlock,
  Implementation,
  McpServer,
  SessionId,
  StopReason,
  ToolCallStatus,
} from './types.js';
