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
export declare class TruncateAndCacheResultCapper implements ResultCapper {
    private maxChars;
    private previewChars;
    constructor(maxChars?: number, previewChars?: number);
    cap(content: string, _toolName: string, toolCallId: string, cache?: PipelineCache | null): string;
    private generatePreview;
}
/** No-op capper for tests or when capping is disabled. */
export declare class NoOpResultCapper implements ResultCapper {
    cap(content: string): string;
}
//# sourceMappingURL=result-capper.d.ts.map