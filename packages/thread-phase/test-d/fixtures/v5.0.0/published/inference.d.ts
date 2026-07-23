/**
 * Inference provider configuration.
 *
 * Single source of truth for which OpenAI-compatible endpoint we hit. Reads
 * from env by default; downstream apps can pass overrides for testing or to
 * point a single process at multiple providers.
 */
import OpenAI from 'openai';
export interface InferenceConfig {
    /** Base URL of the OpenAI-compatible endpoint. Defaults to local vLLM. */
    baseUrl: string;
    /** API key. Local vLLM accepts any non-empty string. */
    apiKey: string;
    /** Default model name for heavy reasoning. */
    defaultModel: string;
    /** Lighter model for cheap/fast phases (planner, classifier, intent gate). */
    lightModel: string;
    /** Context window in tokens. Drives the budget tracker's default. */
    contextLength: number;
}
export declare function loadInferenceConfig(overrides?: Partial<InferenceConfig>): InferenceConfig;
/**
 * Build an OpenAI client pointed at the configured endpoint.
 * Uses the standard `openai` SDK; works against any /v1/chat/completions service.
 */
export declare function createInferenceClient(overrides?: Partial<InferenceConfig>): OpenAI;
//# sourceMappingURL=inference.d.ts.map