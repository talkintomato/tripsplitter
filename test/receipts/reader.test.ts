import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReceiptPrompt,
  createAnthropicReader,
  createTelegramDownloader,
  detectImageType,
  ReceiptReadError,
  receiptReadingSchema,
  toReceiptReadError,
} from '../../src/receipts/index.js';
import { reading } from './harness.js';

// No test here calls the network. The client is a fake that records the request.
type Parse = (params: Record<string, unknown>) => Promise<unknown>;
const fakeClient = (parse: Parse) => ({ messages: { parse } }) as unknown as Pick<Anthropic, 'messages'>;
const image = { data: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), mediaType: 'image/jpeg' as const };
const read = (parse: Parse) => createAnthropicReader({ apiKey: 'test-key', model: 'model-from-config', client: fakeClient(parse) })(image);

describe('the Anthropic reader', () => {
  it('sends the image as base64 data with the prompt and the schema, and returns the parsed answer', async () => {
    const parse = vi.fn<Parse>(async () => ({ stop_reason: 'end_turn', parsed_output: reading() }));
    await expect(read(parse)).resolves.toEqual(reading());

    expect(parse).toHaveBeenCalledTimes(1);
    const params = parse.mock.calls[0]![0] as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      output_config: { format: { type: string; schema: { properties: Record<string, unknown>; required: string[] } } };
    };
    expect(params.model).toBe('model-from-config');
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]!.role).toBe('user');
    expect(params.messages[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(image.data).toString('base64') } },
      { type: 'text', text: buildReceiptPrompt() },
    ]);
    expect(params.output_config.format.type).toBe('json_schema');
    expect(Object.keys(params.output_config.format.schema.properties).sort()).toEqual(Object.keys(receiptReadingSchema.shape).sort());
    // The image goes as data. No URL, and so no bot token, is in what the model is sent.
    expect(JSON.stringify(params.messages)).not.toMatch(/https?:\/\/|api\.telegram\.org/);
    expect(params.messages[0]!.content.map((block) => (block.source as { type?: string } | undefined)?.type)).toEqual(['base64', undefined]);
  });

  it('builds a schema in which every field is required and nothing else is allowed', () => {
    const format = zodOutputFormat(receiptReadingSchema);
    type Node = { $ref?: string; required?: string[]; additionalProperties?: boolean; items?: Node; properties?: Record<string, Node> };
    const schema = format.schema as Node & { required: string[]; properties: Record<string, Node>; $defs?: Record<string, Node> };
    const resolve = (node: Node): Node => (node.$ref ? schema.$defs![node.$ref.replace('#/$defs/', '')]! : node);
    expect([...schema.required].sort()).toEqual(Object.keys(receiptReadingSchema.shape).sort());
    expect(schema.additionalProperties).toBe(false);
    const item = resolve(schema.properties.items!.items!);
    expect([...item.required!].sort()).toEqual(['amount', 'label', 'quantity']);
    expect(item.additionalProperties).toBe(false);
    expect(format.parse(JSON.stringify(reading()))).toEqual(reading());
    expect(() => format.parse(JSON.stringify({ ...reading(), total: 84.5 }))).toThrow();
  });

  it('refuses an answer that does not fit the schema', async () => {
    const error = await read(async () => ({ stop_reason: 'end_turn', parsed_output: { ...reading(), items: 'none' } })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceiptReadError);
    expect(error).toMatchObject({ kind: 'invalid_response', retryable: false });
  });

  it('treats no answer, a refusal and a cut-off answer as errors that a retry cannot fix', async () => {
    await expect(read(async () => ({ stop_reason: 'end_turn', parsed_output: null }))).rejects.toMatchObject({ kind: 'invalid_response', retryable: false });
    await expect(read(async () => ({ stop_reason: 'refusal', parsed_output: null }))).rejects.toMatchObject({ kind: 'refused', retryable: false });
    await expect(read(async () => ({ stop_reason: 'max_tokens', parsed_output: null }))).rejects.toMatchObject({ kind: 'invalid_response', retryable: false });
  });

  it('maps the errors of the SDK', async () => {
    const headers = new Headers();
    const cases: Array<[unknown, string, boolean]> = [
      [new Anthropic.APIConnectionError({ message: 'no route' }), 'network', true],
      [new Anthropic.APIConnectionTimeoutError(), 'network', true],
      [Anthropic.APIError.generate(429, {}, 'slow down', headers), 'rate_limit', true],
      [Anthropic.APIError.generate(500, {}, 'oops', headers), 'unavailable', true],
      [Anthropic.APIError.generate(529, {}, 'overloaded', headers), 'unavailable', true],
      [Anthropic.APIError.generate(400, {}, 'bad image', headers), 'other', false],
      [Anthropic.APIError.generate(401, {}, 'bad key', headers), 'other', false],
      [new Anthropic.AnthropicError('Failed to parse structured output'), 'invalid_response', false],
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
      throw new Anthropic.APIConnectionError({ message: 'no route' });
    });
    await expect(read(parse)).rejects.toBeInstanceOf(ReceiptReadError);
    expect(parse).toHaveBeenCalledTimes(1);
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
