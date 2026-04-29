/**
 * Translation between thread-phase's internal Message shape and the OpenAI
 * chat-completions wire format. Lives at the single boundary so the rest of
 * the framework stays SDK-agnostic.
 */

import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions.js';

import type { Message, ToolDefinition } from '../messages.js';

export function toOpenAIMessages(
  systemPrompt: string,
  messages: Message[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content });
    } else if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const out: ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: msg.content || null,
      };
      if (msg.toolCalls.length > 0) {
        out.tool_calls = msg.toolCalls.map(
          (tc): ChatCompletionMessageToolCall => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          }),
        );
      }
      result.push(out);
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }
  return result;
}

export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
