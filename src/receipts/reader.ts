import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { buildReceiptPrompt } from './prompt.js';
import { receiptReadingSchema, type ReceiptReading } from './schema.js';

export type ReceiptImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** The bytes of a photo. Never a URL: the Telegram file URL holds the bot token. */
export interface ReceiptImage {
  data: Uint8Array;
  mediaType: ReceiptImageType;
}

/**
 * Reads one photo with a vision model. One call to the model per call of this function, with no retry
 * inside, because every model call needs its own reservation against the daily cap.
 * Rejects with `ReceiptReadError`. Any other error is treated as one that a retry cannot fix.
 */
export type ReceiptReader = (image: ReceiptImage) => Promise<ReceiptReading>;

export type ReceiptReadFailure = 'network' | 'rate_limit' | 'unavailable' | 'invalid_response' | 'refused' | 'other';

/** Why a read failed. `retryable` is true for network, rate limit and server-side errors. */
export class ReceiptReadError extends Error {
  readonly kind: ReceiptReadFailure;
  readonly retryable: boolean;

  constructor(kind: ReceiptReadFailure, message: string) {
    super(message);
    this.name = 'ReceiptReadError';
    this.kind = kind;
    this.retryable = kind === 'network' || kind === 'rate_limit' || kind === 'unavailable';
  }
}

/** The image type by the first bytes of the file. Telegram photos are JPEG, which is also the fallback. */
export function detectImageType(data: Uint8Array): ReceiptImageType {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

export interface AnthropicReaderOptions {
  apiKey: string;
  /** `RECEIPT_MODEL` */
  model: string;
  /** Milliseconds for one call. */
  timeoutMs?: number;
  maxTokens?: number;
  /** A ready client, for tests of the request that is built. */
  client?: Pick<Anthropic, 'messages'>;
}

/** Turns an error of the SDK into a `ReceiptReadError`. The message never holds the key or the image. */
export function toReceiptReadError(error: unknown): ReceiptReadError {
  if (error instanceof ReceiptReadError) return error;
  if (error instanceof Anthropic.APIConnectionError) return new ReceiptReadError('network', 'Could not reach the model.');
  if (error instanceof Anthropic.RateLimitError) return new ReceiptReadError('rate_limit', 'The model refused the call: rate limit.');
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    if (status !== undefined && status >= 500) return new ReceiptReadError('unavailable', `The model is not available: status ${status}.`);
    return new ReceiptReadError('other', `The model refused the call: status ${status ?? 'unknown'}.`);
  }
  // Thrown by the SDK when the text of the answer does not fit the schema.
  if (error instanceof Anthropic.AnthropicError) return new ReceiptReadError('invalid_response', 'The answer of the model did not fit the schema.');
  return new ReceiptReadError('other', 'The model call failed.');
}

/** The reader used when `deps.readReceipt` is not given. */
export function createAnthropicReader(options: AnthropicReaderOptions): ReceiptReader {
  // maxRetries 0: a retry is a second model call and needs a second reservation, which the handler makes.
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 0, timeout: options.timeoutMs ?? 60_000 });
  const prompt = buildReceiptPrompt();
  const format = zodOutputFormat(receiptReadingSchema);

  return async (image) => {
    try {
      const message = await client.messages.parse({
        model: options.model,
        max_tokens: options.maxTokens ?? 8192,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(image.data).toString('base64') },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
        output_config: { format },
      });
      if (message.stop_reason === 'refusal') throw new ReceiptReadError('refused', 'The model declined to read the photo.');
      if (message.stop_reason === 'max_tokens') throw new ReceiptReadError('invalid_response', 'The answer of the model was cut off.');
      if (message.parsed_output === null || message.parsed_output === undefined) {
        throw new ReceiptReadError('invalid_response', 'The model returned no structured answer.');
      }
      // Checked again here so that the handler never depends on what the SDK did.
      const checked = receiptReadingSchema.safeParse(message.parsed_output);
      if (!checked.success) throw new ReceiptReadError('invalid_response', 'The answer of the model did not fit the schema.');
      return checked.data;
    } catch (error) {
      throw toReceiptReadError(error);
    }
  };
}
