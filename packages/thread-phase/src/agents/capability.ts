/**
 * Static capability assertions for adapters.
 *
 * Patterns that depend on an adapter ability (resumption, streaming mode,
 * structured output strategy) call `requireCapability` at construction time.
 * Failing here is far cheaper than failing at run time after the agent has
 * already consumed tokens.
 *
 * @internal
 */

import type { AgentAdapterMeta, AgentCapabilities, AgentRunResult } from './protocol.js';

/**
 * Thrown when an adapter does not satisfy a requested capability. Carries
 * the offending adapter id, the capability key, and both the required and
 * actual values so logs surface the mismatch without further indirection.
 *
 * @internal
 */
export class AgentCapabilityError extends Error {
  constructor(
    public adapterId: string,
    public capability: keyof AgentCapabilities,
    public required: unknown,
    public actual: unknown,
  ) {
    super(
      `adapter '${adapterId}' does not satisfy capability '${String(capability)}': ` +
        `required=${JSON.stringify(required)}, actual=${JSON.stringify(actual)}`,
    );
    this.name = 'AgentCapabilityError';
  }
}

/**
 * Assert that an adapter's declared capability matches a required value or
 * passes a predicate. Throws `AgentCapabilityError` on mismatch.
 *
 * The `meta` parameter accepts any adapter regardless of its config/result
 * types — capability checks are config-shape-independent.
 *
 * @internal
 */
export function requireCapability<C extends keyof AgentCapabilities>(
  meta: AgentAdapterMeta<unknown, AgentRunResult>,
  capability: C,
  required: AgentCapabilities[C] | ((actual: AgentCapabilities[C]) => boolean),
): void {
  const actual = meta.capabilities[capability];
  const ok =
    typeof required === 'function'
      ? (required as (a: AgentCapabilities[C]) => boolean)(actual)
      : actual === required;
  if (!ok) {
    throw new AgentCapabilityError(meta.id, capability, required, actual);
  }
}
