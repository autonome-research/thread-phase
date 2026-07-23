/**
 * Translation between thread-phase's internal Message shape and the OpenAI
 * chat-completions wire format. Lives at the single boundary so the rest of
 * the framework stays SDK-agnostic.
 *
 * @internal — both functions are exported for advanced callers (e.g. those
 * driving a custom inference loop) but are not part of the v1 stable
 * surface. They may change between minor versions if the OpenAI SDK
 * evolves.
 */
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';
import type { Message, ToolDefinition } from '../messages.js';
export declare function toOpenAIMessages(systemPrompt: string, messages: Message[]): ChatCompletionMessageParam[];
export declare function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[];
//# sourceMappingURL=openai-adapter.d.ts.map