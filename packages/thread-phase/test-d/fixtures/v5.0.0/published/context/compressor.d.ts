/**
 * Message compressor — Layer 2 of token defense.
 *
 * When the total message history exceeds the compression threshold, older
 * tool-result messages get their content replaced with one-line summaries.
 * Tool call/result pairing is preserved (orphaned calls or results would
 * cause API errors at the next request).
 *
 * Operates on the framework's internal Message shape (see ../messages.ts).
 * Tool results are their own role:'tool' messages with toolCallId pointing
 * back to an assistant message's toolCalls[i].id.
 */
import type { Message } from '../messages.js';
export interface CompressorStrategy {
    compress(messages: Message[], options: CompressionOptions): Message[];
}
export interface CompressionOptions {
    /** Number of leading messages to keep verbatim (system + initial user). */
    protectFirst: number;
    /** Number of trailing messages to keep verbatim (recent context). */
    protectLast: number;
    /** Activity-log entries used to enrich compressed summaries. Optional. */
    activityLog: Array<{
        agent: string;
        action: string;
        detail?: string;
    }>;
}
export declare class DeterministicCompressor implements CompressorStrategy {
    compress(messages: Message[], options: CompressionOptions): Message[];
}
export declare class AggressiveCompressor implements CompressorStrategy {
    compress(messages: Message[], options: CompressionOptions): Message[];
}
export declare function sanitizeToolPairs(messages: Message[]): Message[];
//# sourceMappingURL=compressor.d.ts.map