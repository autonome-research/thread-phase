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

import { Ajv, type ValidateFunction } from 'ajv';
import type { ToolDefinition, ToolExecutor, ToolResult } from '../messages.js';

/**
 * Handler signature — receives parsed args plus optional context, returns the
 * tool's result content as a string. Anything string-shaped works (JSON,
 * markdown, plain text); the agent sees it raw.
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: { toolCallId: string },
) => Promise<string>;

export interface ToolRegistryOptions {
  /** When false, skip schema validation. Default: true. */
  validate?: boolean;
}

interface RegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** Compiled validator if validation is enabled, else null. */
  validator: ValidateFunction | null;
}

export class ToolRegistry implements ToolExecutor {
  private tools = new Map<string, RegistryEntry>();
  private ajv: Ajv | null;

  constructor(options: ToolRegistryOptions = {}) {
    this.ajv = options.validate === false ? null : new Ajv({ allErrors: true, strict: false });
  }

  /**
   * Register a tool. Throws on duplicate names — pipelines should be aware of
   * what they expose, not silently overwrite.
   */
  register(definition: ToolDefinition, handler: ToolHandler): this {
    if (this.tools.has(definition.name)) {
      throw new Error(`ToolRegistry: tool already registered: ${definition.name}`);
    }
    const validator = this.ajv ? this.ajv.compile(definition.inputSchema) : null;
    this.tools.set(definition.name, { definition, handler, validator });
    return this;
  }

  /** All registered tool definitions, in registration order. Hand to AgentConfig.tools. */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((e) => e.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(
    name: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      return {
        toolCallId,
        content: `Error: unknown tool "${name}". Registered tools: ${[...this.tools.keys()].join(', ') || '(none)'}.`,
      };
    }

    if (entry.validator) {
      const ok = entry.validator(args);
      if (!ok) {
        const errs = entry.validator.errors ?? [];
        const detail = errs
          .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
          .join('; ');
        return {
          toolCallId,
          content: `Error: invalid arguments for "${name}": ${detail}`,
        };
      }
    }

    try {
      const content = await entry.handler(args, { toolCallId });
      return { toolCallId, content };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { toolCallId, content: `Error: tool "${name}" threw: ${message}` };
    }
  }
}
