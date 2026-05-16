/**
 * Agent Client Protocol — TypeScript types for the subset this chassis
 * implements. Faithful to the ACP spec at
 * https://agentclientprotocol.com/protocol — field names are literal.
 *
 * We model only the messages the chassis sends or receives: initialize,
 * session/new, session/prompt, session/update notifications, and
 * session/cancel. Optional features (filesystem ops, terminals,
 * session/request_permission, MCP transport configuration) are out of
 * scope for v1 and surface as `native` events when encountered.
 *
 * @internal
 */

/** Negotiated at initialize time; the spec is currently at v1. */
export const ACP_PROTOCOL_VERSION = 1;

export type SessionId = string;

export interface Implementation {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface AgentCapabilities {
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  loadSession?: boolean;
  [key: string]: unknown;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}

// --- initialize ---

export interface InitializeRequest {
  protocolVersion: number;
  clientInfo?: Implementation;
  clientCapabilities?: ClientCapabilities;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentInfo?: Implementation;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
}

// --- session/new and session/load ---

export interface McpServer {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface NewSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
}

export interface NewSessionResponse {
  sessionId: SessionId;
}

export interface LoadSessionRequest {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
}

// --- content blocks ---

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string }
  | { type: 'resource'; resource: unknown };

/** Extract plain text from a single content block (best-effort). */
export function contentBlockToText(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource_link') return `[resource: ${block.name} (${block.uri})]`;
  return `[${block.type}]`;
}

// --- session/prompt ---

export interface PromptRequest {
  sessionId: SessionId;
  prompt: ContentBlock[];
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface PromptResponse {
  stopReason: StopReason;
}

// --- session/update notifications ---

export type ToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: ToolCallStatus;
      content?: ContentBlock[];
      rawInput?: unknown;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      status?: ToolCallStatus;
      content?: ContentBlock[];
      title?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | { sessionUpdate: 'plan'; entries?: unknown[] }
  | { sessionUpdate: 'mode'; mode?: unknown }
  | { sessionUpdate: string; [key: string]: unknown };

export interface SessionNotificationParams {
  sessionId: SessionId;
  update: SessionUpdate;
}

// --- session/cancel ---

export interface CancelNotificationParams {
  sessionId: SessionId;
}

// --- ACP method names (string literals so call sites are uniform) ---

export const ACP_METHODS = {
  initialize: 'initialize',
  newSession: 'session/new',
  loadSession: 'session/load',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
} as const;
