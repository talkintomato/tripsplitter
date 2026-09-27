import OpenAI from 'openai';
import { ContentFilterFinishReasonError, LengthFinishReasonError } from 'openai/error';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReceiptPrompt,
  createOpenAIReader,
  createTelegramDownloader,
  detectImageType,
  ReceiptReadError,
  receiptReadingSchema,
  receiptTextFormat,
  toReceiptReadError,
} from '../../src/receipts/index.js';
import { reading } from './harness.js';

// No test here calls the network. The client is a fake that records the request, or a real client with a fake fetch.
type Parse = (params: Record<string, unknown>) => Promise<unknown>;
const fakeClient = (parse: Parse) => ({ responses: { parse } }) as unknown as Pick<OpenAI, 'responses'>;
const image = { data: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), mediaType: 'image/jpeg' as const };
const read = (parse: Parse) => createOpenAIReader({ apiKey: 'test-key', model: 'model-from-config', client: fakeClient(parse) })(image);
const dataUrl = `data:image/jpeg;base64,${Buffer.from(image.data).toString('base64')}`;

/** An answer as `responses.parse` returns it. */
const answer = (parsed: unknown, more: Record<string, unknown> = {}) => ({
  status: 'completed',
  incomplete_details: null,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(parsed), parsed }] }],
  output_parsed: parsed,
  ...more,
});
const refusal = () => ({
  status: 'completed',
  incomplete_details: null,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
  output_parsed: null,
});
const incomplete = (reason: string) => ({ status: 'incomplete', incomplete_details: { reason }, output: [], output_parsed: null });

/** The body of an answer of the Responses API, as sent over HTTP. */
const wireBody = (content: Array<Record<string, unknown>>, more: Record<string, unknown> = {}) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 0,
  model: 'model-from-config',
  status: 'completed',
  incomplete_details: null,
  error: null,
  output: content.length === 0 ? [] : [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content }],
  ...more,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the OpenAI reader', () => {
  it('sends the image as base64 data with the prompt and the schema, and returns the parsed answer', async () => {
    const parse = vi.fn<Parse>(async () => answer(reading()));
    await expect(read(parse)).resolves.toEqual(reading());

    expect(parse).toHaveBeenCalledTimes(1);
    const params = parse.mock.calls[0]![0] as {
      model: string;
      store: boolean;
      input: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      text: { format: { type: string; name: string; strict: boolean; schema: { properties: Record<string, unknown>; required: string[] } } };
    };
    expect(params.model).toBe('model-from-config');
    expect(params.store).toBe(false);
    expect(params.input).toHaveLength(1);
    expect(params.input[0]!.role).toBe('user');
    expect(params.input[0]!.content).toEqual([
      { type: 'input_image', detail: 'high', image_url: dataUrl },
      { type: 'input_text', text: buildReceiptPrompt() },
    ]);
    expect(params.text.format.type).toBe('json_schema');
    expect(params.text.format.name).toBe('receipt_reading');
    expect(params.text.format.strict).toBe(true);
    expect(Object.keys(params.text.format.schema.properties).sort()).toEqual(Object.keys(receiptReadingSchema.shape).sort());
    // The image goes as data. No URL, and so no bot token, is in what the model is sent.
    expect(JSON.stringify(params.input)).not.toMatch(/https?:\/\/|api\.telegram\.org/);
    expect(params.input[0]!.content[0]!.image_url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('builds a strict schema: every field required, nothing else allowed, only supported keywords', () => {
    const format = receiptTextFormat();
    expect(format.strict).toBe(true);
    type Node = {
      type?: string | string[];
      required?: string[];
      additionalProperties?: boolean;
      items?: Node;
      properties?: Record<string, Node>;
    };
    const schema = format.schema as Node & { required: string[]; properties: Record<string, Node> };
    expect(schema.type).toBe('object');
    expect([...schema.required].sort()).toEqual(Object.keys(receiptReadingSchema.shape).sort());
    expect(schema.additionalProperties).toBe(false);
    const item = schema.properties.items!.items!;
    expect([...item.required!].sort()).toEqual(['amount', 'label', 'quantity']);
    expect(item.additionalProperties).toBe(false);
    // A value that can be null is a union with null, and still required.
    expect(schema.properties.merchant!.type).toEqual(['string', 'null']);
    expect(schema.properties.tax_included!.type).toEqual(['boolean', 'null']);

    // Strict mode refuses keywords outside its subset.
    const allowed = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'description']);
    const walk = (node: unknown, isPropertyMap: boolean): void => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, false));
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (!isPropertyMap) expect(allowed.has(key), `keyword ${key}`).toBe(true);
        walk(value, !isPropertyMap && key === 'properties');
      }
    };
    walk(format.schema, false);
  });

  it('refuses an answer that does not fit the schema', async () => {
    const error = await read(async () => answer({ ...reading(), items: 'none' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceiptReadError);
    expect(error).toMatchObject({ kind: 'invalid_response', retryable: false });
  });

  it('treats no answer, a refusal and a cut-off answer as errors that a retry cannot fix', async () => {
    await expect(read(async () => answer(null))).rejects.toMatchObject({ kind: 'invalid_response', retryable: false });
    await expect(read(async () => ({ status: 'completed', output: [], output_parsed: null }))).rejects.toMatchObject({
      kind: 'invalid_response',
      retryable: false,
    });
    await expect(read(async () => refusal())).rejects.toMatchObject({ kind: 'refused', retryable: false });
    await expect(read(async () => incomplete('max_output_tokens'))).rejects.toMatchObject({ kind: 'invalid_response', retryable: false });
    await expect(read(async () => incomplete('content_filter'))).rejects.toMatchObject({ kind: 'refused', retryable: false });
    await expect(read(async () => ({ status: 'failed', output: [], output_parsed: null }))).rejects.toMatchObject({
      kind: 'other',
      retryable: false,
    });
  });

  it('maps the errors of the SDK', async () => {
    const headers = new Headers();
    const cases: Array<[unknown, string, boolean]> = [
      [new OpenAI.APIConnectionError({ message: 'no route' }), 'network', true],
      [new OpenAI.APIConnectionTimeoutError(), 'network', true],
      [OpenAI.APIError.generate(429, {}, 'slow down', headers), 'rate_limit', true],
      [OpenAI.APIError.generate(500, {}, 'oops', headers), 'unavailable', true],
      [OpenAI.APIError.generate(503, {}, 'overloaded', headers), 'unavailable', true],
      [OpenAI.APIError.generate(400, {}, 'bad image', headers), 'other', false],
      [OpenAI.APIError.generate(401, {}, 'bad key', headers), 'other', false],
      [OpenAI.APIError.generate(404, {}, 'no such model', headers), 'other', false],
      [new OpenAI.APIUserAbortError(), 'other', false],
      [new LengthFinishReasonError(), 'invalid_response', false],
      [new ContentFilterFinishReasonError(), 'refused', false],
      [new OpenAI.OpenAIError('Failed to parse structured output'), 'invalid_response', false],
      [new SyntaxError('Unexpected token'), 'invalid_response', false],
      [new Error('anything'), 'other', false],
    ];
    for (const [thrown, kind, retryable] of cases) {
      expect(toReceiptReadError(thrown)).toMatchObject({ kind, retryable });
      await expect(
        read(async () => {
          throw thrown;
        }),
      ).rejects.toMatchObject({ name: 'ReceiptReadError', kind, retryable });
    }
  });

  it('makes one call and never retries by itself', async () => {
    const parse = vi.fn<Parse>(async () => {
      throw new OpenAI.APIConnectionError({ message: 'no route' });
    });
    await expect(read(parse)).rejects.toBeInstanceOf(ReceiptReadError);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

// The real SDK with a fake `fetch`: what goes over HTTP, and what the SDK does with the answer.
describe('the OpenAI reader through the SDK', () => {
  afterEach(() => vi.unstubAllGlobals());

  type FetchFn = (url: unknown, init?: { method?: string; body?: unknown; headers?: unknown }) => Promise<Response>;
  const viaSdk = (fetchFn: FetchFn) => {
    const client = new OpenAI({ apiKey: 'test-key', maxRetries: 0, fetch: fetchFn as never });
    return createOpenAIReader({ apiKey: 'test-key', model: 'model-from-config', client })(image);
  };

  it('posts one request to the Responses API and parses the text of the answer', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(wireBody([{ type: 'output_text', text: JSON.stringify(reading()), annotations: [] }])));
    await expect(viaSdk(fetchFn)).resolves.toEqual(reading());

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    expect(init!.method?.toUpperCase()).toBe('POST');
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'model-from-config',
      store: false,
      max_output_tokens: 8192,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_image', detail: 'high', image_url: dataUrl },
            { type: 'input_text', text: buildReceiptPrompt() },
          ],
        },
      ],
      text: { format: JSON.parse(JSON.stringify(receiptTextFormat())) },
    });
    expect(String(init!.body)).not.toMatch(/api\.telegram\.org/);
  });

  it('refuses text that is not JSON or does not fit the schema', async () => {
    const texts = ['not json', JSON.stringify({ ...reading(), total: 84.5 }), JSON.stringify({ is_receipt: true })];
    for (const text of texts) {
      await expect(viaSdk(async () => json(wireBody([{ type: 'output_text', text, annotations: [] }])))).rejects.toMatchObject({
        name: 'ReceiptReadError',
        kind: 'invalid_response',
        retryable: false,
      });
    }
  });

  it('handles a refusal and a cut-off answer', async () => {
    await expect(viaSdk(async () => json(wireBody([{ type: 'refusal', refusal: 'No.' }])))).rejects.toMatchObject({
      kind: 'refused',
      retryable: false,
    });
    const cut = wireBody([{ type: 'output_text', text: '{"is_receipt": tr', annotations: [] }], {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
    await expect(viaSdk(async () => json(cut))).rejects.toMatchObject({ kind: 'invalid_response', retryable: false });
  });

  it('maps the HTTP status and a failed connection', async () => {
    const cases: Array<[FetchFn, string, boolean]> = [
      [async () => json({ error: { message: 'slow down' } }, 429), 'rate_limit', true],
      [async () => json({ error: { message: 'oops' } }, 500), 'unavailable', true],
      [async () => json({ error: { message: 'bad image' } }, 400), 'other', false],
      [async () => json({ error: { message: 'bad key' } }, 401), 'other', false],
      [
        async () => {
          throw new TypeError('fetch failed');
        },
        'network',
        true,
      ],
    ];
    for (const [fetchFn, kind, retryable] of cases) {
      await expect(viaSdk(fetchFn)).rejects.toMatchObject({ name: 'ReceiptReadError', kind, retryable });
    }
  });

  it('builds its own client without retries', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json({ error: { message: 'oops' } }, 500));
    vi.stubGlobal('fetch', fetchFn);
    const reader = createOpenAIReader({ apiKey: 'test-key', model: 'model-from-config' });
    await expect(reader(image)).rejects.toMatchObject({ kind: 'unavailable', retryable: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toBe('https://api.openai.com/v1/responses');
  });
});

describe('detectImageType', () => {
  it('tells the type by the first bytes', () => {
    expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(detectImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe('image/gif');
    expect(detectImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(detectImageType(new Uint8Array([]))).toBe('image/jpeg');
  });
});

describe('the Telegram download', () => {
  const token = '123456:SECRET-TOKEN';
  const api = (file: Record<string, unknown>) => ({ getFile: vi.fn(async () => ({ file_id: 'f', file_unique_id: 'u', ...file })) }) as never;

  it('gets the bytes of the file', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const data = await createTelegramDownloader(api({ file_path: 'photos/file_1.jpg' }), token, fetchFn as never)('f');
    expect([...data]).toEqual([1, 2, 3]);
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(`https://api.telegram.org/file/bot${token}/photos/file_1.jpg`);
  });

  it('never puts the token in an error', async () => {
    const failing = [
      vi.fn(async () => {
        throw new Error(`request to https://api.telegram.org/file/bot${token}/x failed`);
      }),
      vi.fn(async () => new Response('no', { status: 404 })),
      vi.fn(async () => new Response(new Uint8Array([]))),
    ];
    for (const fetchFn of failing) {
      const error = (await createTelegramDownloader(api({ file_path: 'x' }), token, fetchFn as never)('f').catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(`${error.message} ${error.stack}`).not.toContain('SECRET-TOKEN');
    }
  });

  it('refuses a file without a path or one that is too large, without a download', async () => {
    const fetchFn = vi.fn();
    await expect(createTelegramDownloader(api({}), token, fetchFn as never)('f')).rejects.toThrow();
    await expect(createTelegramDownloader(api({ file_path: 'x', file_size: 21 * 1024 * 1024 }), token, fetchFn as never)('f')).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
