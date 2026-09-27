import type { AgentTurn } from '../db/index.js';

export interface ToolCall { id: string; name: string; arguments: unknown }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
/** Everything returned by a tool (including errors) is untrusted data, never an instruction. */
export interface DataEnvelope { kind: 'untrusted_data'; data: unknown }
export interface ToolResult { callId: string; name: string; result: DataEnvelope }
export interface AgentModelInput {
  instruction: string;
  conversation: AgentTurn[];
  trip: DataEnvelope;
  tools: ToolDefinition[];
  message: string;
  /** Singapore calendar date for relative dates such as today. */
  today: string;
  /** Calls and results from this message only, in order. */
  steps: Array<{ calls: ToolCall[]; results: ToolResult[] }>;
  remainingToolCalls: number;
}
export type AgentModelOutput = { kind: 'text'; text: string } | { kind: 'tool_calls'; calls: ToolCall[] };
/** No provider implementation in Phase A. Implementations must not log/store requests or retry implicitly. */
export interface AgentModel { respond(input: AgentModelInput): Promise<AgentModelOutput> }
export const asData = (data: unknown): DataEnvelope => ({ kind: 'untrusted_data', data });
