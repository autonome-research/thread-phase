/**
 * Token budget tracking and enforcement.
 *
 * Estimates token usage for the next API request (system + messages + tools)
 * and reports a status code that the agent runner uses to trigger compression
 * or force a final response.
 *
 * Estimator strategy is swappable. Default is a chars-per-token heuristic;
 * downstream can plug in a tiktoken-based estimator for exact counts.
 */
import type { Message, ToolDefinition } from '../messages.js';
export interface TokenEstimator {
    estimate(text: string): number;
    estimateRequest(systemPrompt: string, messages: Message[], tools: ToolDefinition[]): number;
}
/**
 * Default: ~4 chars per token. Accurate enough for budget enforcement.
 * Replace with a tiktoken-based estimator for exact counts.
 */
export declare class RoughTokenEstimator implements TokenEstimator {
    private readonly charsPerToken;
    constructor(charsPerToken?: number);
    estimate(text: string): number;
    estimateRequest(systemPrompt: string, messages: Message[], tools: ToolDefinition[]): number;
}
export interface TokenBudgetConfig {
    contextWindow: number;
    /** Trigger compression at this fraction of available budget (default 0.50). */
    compressionThreshold: number;
    /** Force output at this fraction of available budget (default 0.80). */
    hardStopThreshold: number;
    /** Tokens reserved for the model's response. */
    responseReserve: number;
    /** Per-result cap (chars) before the result-capper truncates. */
    perResultCapChars: number;
    /** Preview size (chars) when a result is capped. */
    previewSizeChars: number;
    /**
     * Leading messages preserved verbatim during compression — typically the
     * system prompt and the seed user message. Default 1.
     */
    protectFirst: number;
    /**
     * Trailing messages preserved verbatim during compression — recent context
     * the model needs to make progress. Default 6 (deterministic) / 4 (aggressive).
     * Set to a per-pipeline value when the workflow needs more or less recent history.
     */
    protectLast: number;
    /** Trailing messages preserved during the aggressive (HARD_STOP) compressor. Default 4. */
    protectLastAggressive: number;
}
export declare enum BudgetStatus {
    OK = "ok",
    COMPRESS = "compress",
    HARD_STOP = "hard_stop"
}
export interface BudgetCheck {
    status: BudgetStatus;
    estimatedTokens: number;
    /** 0.0 to 1.0+. Fraction of (contextWindow - responseReserve). */
    budgetUsed: number;
    compressionThreshold: number;
    hardStopThreshold: number;
}
export declare class TokenBudgetTracker {
    private config;
    private estimator;
    constructor(config?: Partial<TokenBudgetConfig>, estimator?: TokenEstimator);
    check(systemPrompt: string, messages: Message[], tools: ToolDefinition[]): BudgetCheck;
    getResultCap(): {
        maxChars: number;
        previewChars: number;
    };
    getProtectCounts(): {
        protectFirst: number;
        protectLast: number;
        protectLastAggressive: number;
    };
    getEstimator(): TokenEstimator;
}
//# sourceMappingURL=token-budget.d.ts.map