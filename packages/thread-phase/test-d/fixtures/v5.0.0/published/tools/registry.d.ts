/**
 * Tool registry — name → {definition, handler} dispatch with optional
 * JSON-Schema validation of arguments.
 *
 * Implements `ToolExecutor` so it can be passed directly to
 * `runAgentWithTools({ ..., toolExecutor: registry })`.
 *
 * Validation behaviour: when enabled (the default), arguments coming back
 * from the model are checked against the tool's `inputSchema` before the
 * handler runs. Failures return an error string to the agent rather than
 * throwing — the model gets to read what went wrong and try again.
 *
 * Same policy for unknown tools and handler exceptions: errors become
 * agent-readable strings, not thrown exceptions, so a single bad tool call
 * doesn't kill the whole pipeline.
 */
import type { ToolDefinition, ToolExecutor, ToolResult } from '../messages.js';
/**
 * Handler signature — receives parsed args plus optional context, returns the
 * tool's result content as a string. Anything string-shaped works (JSON,
 * markdown, plain text); the agent sees it raw.
 *
 * `context.signal` is the agent runner's AbortSignal when one was provided.
 * Long-running tools (fetch, subprocess, file I/O) can observe it to cancel
 * cooperatively. Synchronous or fast tools may ignore it.
 */
export type ToolHandler = (args: Record<string, unknown>, context: {
    toolCallId: string;
    signal?: AbortSignal;
}) => Promise<string>;
export interface ToolRegistryOptions {
    /** When false, skip schema validation. Default: true. */
    validate?: boolean;
}
export declare class ToolRegistry implements ToolExecutor {
    private tools;
    private ajv;
    constructor(options?: ToolRegistryOptions);
    /**
     * Register a tool. Throws on duplicate names — pipelines should be aware of
     * what they expose, not silently overwrite.
     */
    register(definition: ToolDefinition, handler: ToolHandler): this;
    /** All registered tool definitions, in registration order. Hand to AgentConfig.tools. */
    definitions(): ToolDefinition[];
    has(name: string): boolean;
    execute(name: string, toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}
//# sourceMappingURL=registry.d.ts.map