import OpenAI from 'openai';
import { ContentFilterFinishReasonError, LengthFinishReasonError } from 'openai/error';
import { zodTextFormat } from 'openai/helpers/zod';
import { ZodError } from 'zod';
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

export interface OpenAIReaderOptions {
  apiKey: string;
  /** `RECEIPT_MODEL` */
  model: string;
  /** Milliseconds for one call. */
  timeoutMs?: number;
  /** A ready client, for tests of the request that is built. */
  client?: Pick<OpenAI, 'responses'>;
}

/** The name the schema is sent under. */
export const RECEIPT_FORMAT_NAME = 'receipt_reading';

/** The strict JSON schema of the answer, built from the Zod schema. */
export function receiptTextFormat() {
  return zodTextFormat(receiptReadingSchema, RECEIPT_FORMAT_NAME);
}

/** Turns an error of the SDK into a `ReceiptReadError`. The message never holds the key or the image. */
export function toReceiptReadError(error: unknown): ReceiptReadError {
  if (error instanceof ReceiptReadError) return error;
  // Covers the timeout, which is a connection error in the SDK.
  if (error instanceof OpenAI.APIConnectionError) return new ReceiptReadError('network', 'Could not reach the model.');
  if (error instanceof OpenAI.RateLimitError) return new ReceiptReadError('rate_limit', 'The model refused the call: rate limit.');
  if (error instanceof OpenAI.APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    if (status === 429) return new ReceiptReadError('rate_limit', 'The model refused the call: rate limit.');
    if (status !== undefined && status >= 500) return new ReceiptReadError('unavailable', `The model is not available: status ${status}.`);
    return new ReceiptReadError('other', `The model refused the call: status ${status ?? 'unknown'}.`);
  }
  if (error instanceof ContentFilterFinishReasonError) return new ReceiptReadError('refused', 'The model declined to read the photo.');
  if (error instanceof LengthFinishReasonError) return new ReceiptReadError('invalid_response', 'The answer of the model was cut off.');
  // Thrown while the SDK parses the text of the answer: not JSON, or JSON that does not fit the schema.
  if (error instanceof OpenAI.OpenAIError || error instanceof ZodError || error instanceof SyntaxError) {
    return new ReceiptReadError('invalid_response', 'The answer of the model did not fit the schema.');
  }
  return new ReceiptReadError('other', 'The model call failed.');
}

/** The reader used when `deps.readReceipt` is not given. One call to the Responses API per photo. */
export function createOpenAIReader(options: OpenAIReaderOptions): ReceiptReader {
  // maxRetries 0: a retry is a second model call and needs a second reservation, which the handler makes.
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: options.timeoutMs ?? 60_000 });
  const prompt = buildReceiptPrompt();
  const format = receiptTextFormat();

  return async (image) => {
    try {
      const response = await client.responses.parse({
        model: options.model,
        // Receipts can hold names and card numbers: the provider is asked not to keep the call.
        store: false,
        // Bounds the cost of one call. A long bill is a few thousand tokens.
        max_output_tokens: 8192,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_image',
                detail: 'high',
                // A data URL with the bytes. Never the Telegram URL, which holds the bot token.
                image_url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
              },
              { type: 'input_text', text: prompt },
            ],
          },
        ],
        text: { format },
      });

      const refused = response.output.some((item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'));
      if (refused) throw new ReceiptReadError('refused', 'The model declined to read the photo.');
      if (response.status === 'incomplete') {
        if (response.incomplete_details?.reason === 'content_filter') {
          throw new ReceiptReadError('refused', 'The model declined to read the photo.');
        }
        throw new ReceiptReadError('invalid_response', 'The answer of the model was cut off.');
      }
      if (response.status !== undefined && response.status !== 'completed') {
        throw new ReceiptReadError('other', `The model did not finish the call: ${response.status}.`);
      }
      if (response.output_parsed === null || response.output_parsed === undefined) {
        throw new ReceiptReadError('invalid_response', 'The model returned no structured answer.');
      }
      // Checked again here so that the handler never depends on what the SDK did.
      const checked = receiptReadingSchema.safeParse(response.output_parsed);
      if (!checked.success) throw new ReceiptReadError('invalid_response', 'The answer of the model did not fit the schema.');
      return checked.data;
    } catch (error) {
      throw toReceiptReadError(error);
    }
  };
}
