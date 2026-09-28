import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { ContentFilterFinishReasonError, LengthFinishReasonError } from 'openai/error';
import { createOpenAIAgentModel, toAgentModelError } from '../../src/agent/openai.js';
import { strictParameters, decodeArguments } from '../../src/agent/schema.js';
import { asData, type AgentModelInput } from '../../src/agent/model.js';
import { toolDefinitions, runTool } from '../../src/tools/index.js';
import { fixture, expense, type Fixture } from './helpers.js';

const parameters = { type: 'object', properties: { tripId: { type: 'integer', minimum: 1 } }, additionalProperties: false };
const input = (): AgentModelInput => ({ instruction: 'Fixed instruction.', today: '2026-09-28', trip: asData({ name: 'Trip' }), conversation: [], message: 'Who owes what?', tools: [{ name: 'get_balances', description: 'Balances.', parameters }], steps: [], remainingToolCalls: 6 });
const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'opaque' };
const call = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'get_balances', arguments: '{"tripId":null}', status: 'completed' };
const answer = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Ready.', annotations: [] }] };
const response = (output: unknown[], extra = {}) => ({ id: 'resp_1', object: 'response', created_at: 0, model: 'configured', status: 'completed', incomplete_details: null, error: null, output, ...extra });
const expected = () => ({ model: 'configured', store: false, max_output_tokens: 4096, instructions: 'Fixed instruction.', include: ['reasoning.encrypted_content'],
  input: [{ role: 'user', content: JSON.stringify(asData({ today: '2026-09-28', trip: asData({ name: 'Trip' }), conversation: [], message: 'Who owes what?' })) }],
  tools: [{ type: 'function', name: 'get_balances', description: 'Balances.', strict: true, parameters: { type: 'object', additionalProperties: false, required: ['tripId'], properties: { tripId: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'null means leave unspecified.' } } } }], parallel_tool_calls: false, tool_choice: 'auto' });
const opened: Fixture[] = [];
afterEach(() => { vi.unstubAllGlobals(); opened.splice(0).forEach(f => f.db.close()); });

it('sends exact requests through a fake client, including the tool result and ordered reasoning replay', async () => {
  const create = vi.fn().mockResolvedValueOnce(response([reasoning, call])).mockResolvedValueOnce(response([answer]));
  const model = createOpenAIAgentModel({ apiKey: 'fake', model: 'configured', timeoutMs: 1234, client: { responses: { create } } as never });
  const request = input();
  const first = await model.respond(request);
  expect(first).toMatchObject({ kind: 'tool_calls', calls: [{ id: 'call_1', name: 'get_balances', arguments: {} }] });
  if (first.kind !== 'tool_calls') throw new Error('Missing call');
  request.steps.push({ calls: first.calls, results: [{ callId: 'call_1', name: 'get_balances', result: asData({ balances: [] }) }], providerOutput: first.providerOutput });
  expect(await model.respond(request)).toEqual({ kind: 'text', text: 'Ready.' });
  expect(create.mock.calls).toEqual([
    [expected(), { timeout: 1234, maxRetries: 0 }],
    [{ ...expected(), input: [...expected().input, reasoning, call, { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify(asData({ balances: [] })) }] }, { timeout: 1234, maxRetries: 0 }],
  ]);
});
it('sends the exact same two HTTP bodies through the installed SDK and fake fetch', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(response([reasoning, call]))).mockResolvedValueOnce(Response.json(response([answer])));
  const client = new OpenAI({ apiKey: 'fake', fetch }); // Adapter overrides even SDK defaults.
  const model = createOpenAIAgentModel({ apiKey: 'fake', model: 'configured', client });
  const request = input();
  const first = await model.respond(request);
  if (first.kind !== 'tool_calls') throw new Error('Missing call');
  request.steps.push({ calls: first.calls, results: [{ callId: 'call_1', name: 'get_balances', result: asData({ balances: [] }) }], providerOutput: first.providerOutput });
  expect(await model.respond(request)).toEqual({ kind: 'text', text: 'Ready.' });
  expect(fetch.mock.calls.map(([url, init]) => [url, init.method, JSON.parse(init.body)])).toEqual([
    ['https://api.openai.com/v1/responses', 'POST', expected()],
    ['https://api.openai.com/v1/responses', 'POST', { ...expected(), input: [...expected().input, reasoning, call, { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify(asData({ balances: [] })) }] }],
  ]);
});
it('all tool schemas are strict recursively and use only the conservative supported subset', () => {
  const allowed = new Set(['type', 'enum', 'description', 'anyOf', 'properties', 'required', 'additionalProperties', 'items']);
  function walk(node: Record<string, any>): void {
    for (const key of Object.keys(node)) expect(allowed.has(key), key).toBe(true);
    if (node.type === 'object') {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties));
      Object.values(node.properties).forEach(v => walk(v as Record<string, any>));
    }
    if (node.items) walk(node.items);
    if (node.anyOf) node.anyOf.forEach(walk);
  }
  for (const tool of toolDefinitions) walk(strictParameters(tool.parameters));
});
it('preserves omitted versus explicit null edits and nested optional fields without changing tool meaning', async () => {
  const f = fixture(); opened.push(f);
  const e = expense(f, 'confirmed', { merchant: 'Original' });
  const schema = toolDefinitions.find(t => t.name === 'edit_expense')!.parameters;
  const omitted = decodeArguments({ expenseId: e.id, changes: { merchant: null, amount: null, items: null } }, schema);
  expect(omitted).toEqual({ expenseId: e.id, changes: {} });
  const cleared = decodeArguments({ expenseId: e.id, changes: { merchant: { value: null }, rateOverride: { value: null }, people: [{ name: 'me', weight: null }] } }, schema);
  expect(cleared).toEqual({ expenseId: e.id, changes: { merchant: null, rateOverride: null, people: [{ name: 'me' }] } });
  const unchanged = await runTool(f.context, 'edit_expense', omitted);
  const changed = await runTool(f.context, 'edit_expense', cleared);
  expect(unchanged).toMatchObject({ plans: [{ action: { input: { merchant: 'Original' } } }] });
  expect(changed).toMatchObject({ plans: [{ action: { input: { merchant: null, rateOverride: null } } }] });
  await expect(runTool(f.context, 'edit_expense', decodeArguments({ expenseId: e.id, changes: { amount: '-1' } }, schema))).rejects.toThrow();
});
describe('unusable responses', () => {
  it.each([
    [response([]), 'invalid_response'],
    [response([{ ...answer, content: [{ type: 'output_text', text: ' ' }] }]), 'invalid_response'],
    [response([{ ...answer, content: [{ type: 'refusal', refusal: 'No' }] }]), 'refused'],
    [response([call], { status: 'incomplete' }), 'invalid_response'],
    [response([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), 'refused'],
    [response([], { status: 'failed' }), 'other'],
    [response([{ ...call, arguments: 'invalid json' }]), 'invalid_response'],
    [response([{ ...call, name: 'reset_link' }]), 'invalid_response'],
  ])('maps a refusal or unusable response (%#)', async (body, kind) => {
    const create = vi.fn().mockResolvedValue(body);
    const model = createOpenAIAgentModel({ apiKey: 'fake', model: 'configured', client: { responses: { create } } as never });
    await expect(model.respond(input())).rejects.toMatchObject({ kind });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
it('maps SDK errors without including server text and never retries, including on a supplied client', async () => {
  for (const [status, kind] of [[429, 'rate_limit'], [503, 'unavailable'], [401, 'other']] as const) {
    const fetch = vi.fn(async () => Response.json({ error: { message: 'private secret' } }, { status }));
    const model = createOpenAIAgentModel({ apiKey: 'fake', model: 'configured', client: new OpenAI({ apiKey: 'fake', fetch }) });
    await expect(model.respond(input())).rejects.toMatchObject({ kind, message: `Agent model failed: ${kind}.` });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  for (const [error, kind] of [[new OpenAI.APIConnectionTimeoutError(), 'network'], [new OpenAI.APIConnectionError({ message: 'private' }), 'network'], [new ContentFilterFinishReasonError(), 'refused'], [new LengthFinishReasonError(), 'invalid_response'], [new SyntaxError('private'), 'invalid_response'], [new Error('private'), 'other']] as const) {
    expect(toAgentModelError(error)).toMatchObject({ kind, message: `Agent model failed: ${kind}.` });
  }
});
it('builds a client with retries and logging off', async () => {
  const fetch = vi.fn(async () => Response.json({ error: { message: 'private' } }, { status: 500 }));
  vi.stubGlobal('fetch', fetch);
  await expect(createOpenAIAgentModel({ apiKey: 'fake', model: 'configured' }).respond(input())).rejects.toMatchObject({ kind: 'unavailable' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('maps connection failures and enforces the timeout through the real SDK with no retries', async () => {
  const failedFetch = vi.fn(async () => { throw new TypeError('private connection detail'); });
  const failed = createOpenAIAgentModel({ apiKey: 'fake', model: 'configured', client: new OpenAI({ apiKey: 'fake', fetch: failedFetch }) });
  await expect(failed.respond(input())).rejects.toMatchObject({ kind: 'network' });
  expect(failedFetch).toHaveBeenCalledTimes(1);
  const hangingFetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const timed = createOpenAIAgentModel({ apiKey: 'fake', model: 'configured', timeoutMs: 10, client: new OpenAI({ apiKey: 'fake', fetch: hangingFetch }) });
  await expect(timed.respond(input())).rejects.toMatchObject({ kind: 'network' });
  expect(hangingFetch).toHaveBeenCalledTimes(1);
});
