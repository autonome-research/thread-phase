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

const DEFAULT_BASE_URL = 'http://localhost:8000/v1';
const DEFAULT_MODEL = 'qwen3.6-27b';
const DEFAULT_CONTEXT_LENGTH = 131_072;

export function loadInferenceConfig(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  const defaultModel = process.env.INFERENCE_MODEL ?? DEFAULT_MODEL;
  return {
    baseUrl: process.env.INFERENCE_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: process.env.INFERENCE_API_KEY ?? 'not-needed-for-local-vllm',
    defaultModel,
    lightModel: process.env.INFERENCE_MODEL_LIGHT ?? defaultModel,
    contextLength: Number(process.env.INFERENCE_CONTEXT_LENGTH ?? DEFAULT_CONTEXT_LENGTH),
    ...overrides,
  };
}

/**
 * Build an OpenAI client pointed at the configured endpoint.
 * Uses the standard `openai` SDK; works against any /v1/chat/completions service.
 */
export function createInferenceClient(overrides: Partial<InferenceConfig> = {}): OpenAI {
  const config = loadInferenceConfig(overrides);
  return new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });
}
