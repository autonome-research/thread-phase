/**
 * Internal message representation.
 *
 * thread-phase uses its own Message shape so the framework isn't coupled to
 * either Anthropic's content-block model or OpenAI's tool-call model.
 * Translation to/from the wire format happens at the inference boundary
 * (see agent-runner.ts).
 *
 * Shape choice: closer to OpenAI than Anthropic, because:
 * - tool_calls live on the assistant message as a separate field, not as
 *   embedded content blocks.
 * - tool results are their own role:'tool' messages with a tool_call_id link.
 * This matches vLLM / Ollama / llama.cpp / OpenAI all natively, and the
 * Anthropic SDK can be adapted at the boundary if ever needed.
 */

// ---------------------------------------------------------------------------
// Tool call (the assistant decided to invoke a tool)
// ---------------------------------------------------------------------------

export interface ToolCall {
  /** Unique id for this call. Used to match tool result messages back to the call. */
  id: string;
  /** Tool name from the registered ToolDefinition. */
  name: string;
  /** Parsed arguments. The framework parses JSON from the wire and passes structured args. */
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  /** May be empty string when the assistant only emitted tool calls. */
  content: string;
  /** Empty array when no tool calls were made. */
  toolCalls: ToolCall[];
}

export interface ToolResultMessage {
  role: 'tool';
  /** Must match a ToolCall.id from a prior assistant message. */
  toolCallId: string;
  content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Tool definition (registered tools the agent may call)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (object). Translated to OpenAI's `function.parameters` at the boundary. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Tool execution interface — downstream apps register their own executor.
// ---------------------------------------------------------------------------

export interface ToolResult {
  toolCallId: string;
  content: string;
}

export interface ToolExecutor {
  execute(name: string, toolCallId: string, args: Record<string, unknown>): Promise<ToolResult>;
}
