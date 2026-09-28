import OpenAI from 'openai';
import { ContentFilterFinishReasonError, LengthFinishReasonError } from 'openai/error';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { ResponseCreateParamsNonStreaming, ResponseInputItem } from 'openai/resources/responses/responses';
import { asData, type AgentModel, type AgentModelInput } from './model.js';
import { strictParameters, decodeArguments } from './schema.js';

export type AgentModelFailure = 'network' | 'rate_limit' | 'unavailable' | 'invalid_response' | 'refused' | 'other';
export class AgentModelError extends Error {
  readonly retryable: boolean;
  constructor(readonly kind: AgentModelFailure) {
    super(`Agent model failed: ${kind}.`);
    this.name = 'AgentModelError';
    this.retryable = ['network', 'rate_limit', 'unavailable'].includes(kind);
  }
}
export function toAgentModelError(error: unknown): AgentModelError {
  if (error instanceof AgentModelError) return error;
  if (error instanceof OpenAI.APIConnectionError) return new AgentModelError('network');
  if (error instanceof OpenAI.RateLimitError) return new AgentModelError('rate_limit');
  if (error instanceof OpenAI.APIError) return new AgentModelError(error.status === 429 ? 'rate_limit' : (error.status ?? 0) >= 500 ? 'unavailable' : 'other');
  if (error instanceof ContentFilterFinishReasonError) return new AgentModelError('refused');
  if (error instanceof LengthFinishReasonError || error instanceof OpenAI.OpenAIError || error instanceof SyntaxError) return new AgentModelError('invalid_response');
  return new AgentModelError('other');
}
export function agentRequest(input: AgentModelInput, model: string): ResponseCreateParamsNonStreaming {
  const history: ResponseInputItem[] = [
    { role: 'user', content: JSON.stringify(asData({ today: input.today, trip: input.trip, conversation: input.conversation, message: input.message })) },
  ];
  for (const step of input.steps) {
    // Opaque replay state is returned by this adapter, kept in memory for this turn only.
    history.push(...(step.providerOutput as ResponseInputItem[] | undefined ?? step.calls.map(c => ({ type: 'function_call' as const, call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) }))));
    history.push(...step.results.map(r => ({ type: 'function_call_output' as const, call_id: r.callId, output: JSON.stringify(r.result) })));
  }
  return {
    model, store: false, max_output_tokens: 4096,
    instructions: input.instruction,
    include: ['reasoning.encrypted_content'],
    input: history,
    tools: input.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: strictParameters(t.parameters), strict: true })),
    parallel_tool_calls: false,
    tool_choice: input.remainingToolCalls > 0 ? 'auto' : 'none',
  };
}
export interface OpenAIAgentOptions { apiKey: string; model: string; timeoutMs?: number; client?: Pick<OpenAI, 'responses'> }
export function createOpenAIAgentModel(options: OpenAIAgentOptions): AgentModel {
  const timeout = options.timeoutMs ?? 60_000;
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey, timeout, maxRetries: 0, logLevel: 'off' });
  return {
    async respond(input) {
      try {
        const response = await client.responses.create(agentRequest(input, options.model), { timeout, maxRetries: 0 });
        if (response.output.some(item => item.type === 'message' && item.content.some(part => part.type === 'refusal')) || response.incomplete_details?.reason === 'content_filter') throw new AgentModelError('refused');
        if (response.status === 'incomplete') throw new AgentModelError('invalid_response');
        if (response.status !== 'completed') throw new AgentModelError('other');
        const calls = response.output.filter(item => item.type === 'function_call').map(item => {
          const definition = input.tools.find(t => t.name === item.name);
          if (!definition || !item.call_id || item.status === 'incomplete') throw new AgentModelError('invalid_response');
          return { id: item.call_id, name: item.name, arguments: decodeArguments(JSON.parse(item.arguments), definition.parameters) };
        });
        if (calls.length) {
          if (new Set(calls.map(c => c.id)).size !== calls.length) throw new AgentModelError('invalid_response');
          return { kind: 'tool_calls', calls, providerOutput: toResponseInputItems(response.output) };
        }
        const text = response.output.flatMap(item => item.type === 'message' ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : []).join('\n').trim();
        if (!text) throw new AgentModelError('invalid_response');
        return { kind: 'text', text };
      } catch (error) { throw toAgentModelError(error); }
    },
  };
}
