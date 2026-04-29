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

// ---------------------------------------------------------------------------
// Estimator interface (swappable)
// ---------------------------------------------------------------------------

export interface TokenEstimator {
  estimate(text: string): number;
  estimateRequest(systemPrompt: string, messages: Message[], tools: ToolDefinition[]): number;
}

/**
 * Default: ~4 chars per token. Accurate enough for budget enforcement.
 * Replace with a tiktoken-based estimator for exact counts.
 */
export class RoughTokenEstimator implements TokenEstimator {
  private readonly charsPerToken: number;

  constructor(charsPerToken: number = 4) {
    this.charsPerToken = charsPerToken;
  }

  estimate(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / this.charsPerToken);
  }

  estimateRequest(systemPrompt: string, messages: Message[], tools: ToolDefinition[]): number {
    let totalChars = 0;
    if (systemPrompt) totalChars += systemPrompt.length;
    if (messages.length > 0) totalChars += JSON.stringify(messages).length;
    if (tools.length > 0) totalChars += JSON.stringify(tools).length;
    return Math.ceil(totalChars / this.charsPerToken);
  }
}

// ---------------------------------------------------------------------------
// Budget configuration
// ---------------------------------------------------------------------------

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
}

const DEFAULT_CONFIG: TokenBudgetConfig = {
  contextWindow: 131_072,
  compressionThreshold: 0.5,
  hardStopThreshold: 0.8,
  responseReserve: 4_096,
  perResultCapChars: 12_000,
  previewSizeChars: 1_500,
};

// ---------------------------------------------------------------------------
// Budget tracker
// ---------------------------------------------------------------------------

export enum BudgetStatus {
  OK = 'ok',
  COMPRESS = 'compress',
  HARD_STOP = 'hard_stop',
}

export interface BudgetCheck {
  status: BudgetStatus;
  estimatedTokens: number;
  /** 0.0 to 1.0+. Fraction of (contextWindow - responseReserve). */
  budgetUsed: number;
  compressionThreshold: number;
  hardStopThreshold: number;
}

export class TokenBudgetTracker {
  private config: TokenBudgetConfig;
  private estimator: TokenEstimator;

  constructor(config: Partial<TokenBudgetConfig> = {}, estimator?: TokenEstimator) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.estimator = estimator ?? new RoughTokenEstimator();
  }

  check(systemPrompt: string, messages: Message[], tools: ToolDefinition[]): BudgetCheck {
    const estimatedTokens = this.estimator.estimateRequest(systemPrompt, messages, tools);
    const available = this.config.contextWindow - this.config.responseReserve;
    const budgetUsed = estimatedTokens / available;

    let status = BudgetStatus.OK;
    if (budgetUsed >= this.config.hardStopThreshold) {
      status = BudgetStatus.HARD_STOP;
    } else if (budgetUsed >= this.config.compressionThreshold) {
      status = BudgetStatus.COMPRESS;
    }

    return {
      status,
      estimatedTokens,
      budgetUsed,
      compressionThreshold: this.config.compressionThreshold,
      hardStopThreshold: this.config.hardStopThreshold,
    };
  }

  getResultCap(): { maxChars: number; previewChars: number } {
    return {
      maxChars: this.config.perResultCapChars,
      previewChars: this.config.previewSizeChars,
    };
  }

  getEstimator(): TokenEstimator {
    return this.estimator;
  }
}
