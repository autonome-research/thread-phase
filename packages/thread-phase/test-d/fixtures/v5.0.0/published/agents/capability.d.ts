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
export declare class AgentCapabilityError extends Error {
    adapterId: string;
    capability: keyof AgentCapabilities;
    required: unknown;
    actual: unknown;
    constructor(adapterId: string, capability: keyof AgentCapabilities, required: unknown, actual: unknown);
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
export declare function requireCapability<C extends keyof AgentCapabilities>(meta: AgentAdapterMeta<unknown, AgentRunResult>, capability: C, required: AgentCapabilities[C] | ((actual: AgentCapabilities[C]) => boolean)): void;
//# sourceMappingURL=capability.d.ts.map