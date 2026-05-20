/**
 * Tool-result capping — Layer 1 of token defense.
 *
 * Caps individual tool results before they enter the message history.
 * Oversize results get a preview returned and (optionally) the full content
 * stored in the pipeline cache for later retrieval.
 */

import type { PipelineCache } from '../cache.js';

export interface ResultCapper {
  /**
   * Cap a tool result. If under limit, returns as-is.
   * If over, returns a preview and (if cache is provided) stows the full
   * content under `full_result:{toolCallId}` for later retrieval.
   */
  cap(content: string, toolName: string, toolCallId: string, cache?: PipelineCache | null): string;
}

/**
 * Default capper: truncate at last newline within the preview budget,
 * cache full content if a cache is provided.
 */
export class TruncateAndCacheResultCapper implements ResultCapper {
  private maxChars: number;
  private previewChars: number;

  constructor(maxChars: number = 12_000, previewChars: number = 1_500) {
    this.maxChars = maxChars;
    this.previewChars = previewChars;
  }

  cap(content: string, _toolName: string, toolCallId: string, cache?: PipelineCache | null): string {
    if (content.length <= this.maxChars) {
      return content;
    }

    const preview = this.generatePreview(content);
    const fullLength = content.length;

    if (cache) {
      cache.set(`full_result:${toolCallId}`, content);
    }

    return (
      `[Result capped: ${fullLength} chars total, showing first ${preview.length} chars. ` +
      `Full result available in pipeline cache (key: full_result:${toolCallId}).]\n\n` +
      preview
    );
  }

  private generatePreview(content: string): string {
    if (content.length <= this.previewChars) {
      return content;
    }

    const truncated = content.slice(0, this.previewChars);
    const lastNewline = truncated.lastIndexOf('\n');
    if (lastNewline > this.previewChars / 2) {
      return truncated.slice(0, lastNewline + 1) + '\n...[truncated]';
    }

    return truncated + '\n...[truncated]';
  }
}

/** No-op capper for tests or when capping is disabled. */
export class NoOpResultCapper implements ResultCapper {
  cap(content: string): string {
    return content;
  }
}
