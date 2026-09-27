import { z } from 'zod';
import { ValidationError } from '../db/index.js';
import type { ApiContext } from './context.js';

// These check the shape of a request. What the values may be is decided by the operations of the
// database, whose messages are written for members. Unknown fields are dropped, which is what keeps
// a request from naming its own actor.

const wholeNumber = z.number().int();

const share = z.object({ memberId: wholeNumber, weight: wholeNumber.optional() });

const item = z.object({
  label: z.string(),
  quantity: z.number().optional(),
  amount: wholeNumber,
  shares: z.array(share).optional(),
});

const expenseFields = {
  payerId: wholeNumber,
  description: z.string().optional(),
  merchant: z.string().nullable().optional(),
  expenseDate: z.string(),
  total: wholeNumber,
  tax: wholeNumber.optional(),
  taxIncluded: z.boolean().optional(),
  tip: wholeNumber.optional(),
  serviceCharge: wholeNumber.optional(),
  discount: wholeNumber.optional(),
  currency: z.string().optional(),
  currencyNeedsReview: z.boolean().optional(),
  rateOverride: z.string().nullable().optional(),
  splitType: z.enum(['even', 'portions', 'items']),
  receiptFileId: z.string().nullable().optional(),
  items: z.array(item).optional(),
  shares: z.array(share),
};

export const createExpenseBody = z.object({ ...expenseFields, status: z.enum(['draft', 'confirmed']).optional() });
export const saveExpenseBody = z.object({ ...expenseFields, version: wholeNumber, confirm: z.boolean().optional() });
export const versionBody = z.object({ version: wholeNumber });
export const createTripBody = z.object({ name: z.string().optional(), homeCurrency: z.string().optional() });
export const patchTripBody = z.object({
  name: z.string().optional(),
  homeCurrency: z.string().optional(),
  setupDone: z.literal(true).optional(),
});
export const createSettlementBody = z.object({ fromMemberId: wholeNumber, toMemberId: wholeNumber, amount: wholeNumber });
export const addMemberBody = z.object({ displayName: z.string() });

const FIELD_NAMES: Record<string, string> = {
  payerId: 'who paid',
  expenseDate: 'the date',
  total: 'the amount',
  splitType: 'how to split',
  shares: 'the people included',
  items: 'the items',
  version: 'the version',
  amount: 'the amount',
  fromMemberId: 'who paid',
  toMemberId: 'who was paid',
  displayName: 'the name',
  name: 'the name',
  homeCurrency: 'the currency',
  serviceCharge: 'the service charge',
  taxIncluded: 'whether tax is in the prices',
  rateOverride: 'the exchange rate',
};

/** Drops the fields that were sent as undefined, so that "left out" stays left out. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) if (field !== undefined) out[key] = field;
  return out as T;
}

/** Reads and checks a JSON body. `optional` allows a request with no body at all. */
export async function readBody<S extends z.ZodType>(c: ApiContext, schema: S, options: { optional?: boolean } = {}): Promise<z.output<S>> {
  let raw: unknown;
  const text = await c.req.text();
  if (text.trim() === '') {
    if (!options.optional) throw new ValidationError('invalid_input', 'The request is missing its details.');
    raw = {};
  } else {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ValidationError('invalid_input', 'The request could not be read.');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))].filter((f) => f !== '');
    const names = fields.map((f) => FIELD_NAMES[f] ?? f);
    throw new ValidationError(
      'invalid_input',
      names.length > 0 ? `Something is missing or not valid: ${names.join(', ')}.` : 'The request is missing its details.',
    );
  }
  const data = parsed.data;
  return (typeof data === 'object' && data !== null && !Array.isArray(data) ? compact(data) : data) as z.output<S>;
}
