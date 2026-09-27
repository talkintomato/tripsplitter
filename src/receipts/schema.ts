import { z } from 'zod';

/** One printed line of a receipt. `amount` is the full line total as printed; quantity is never multiplied in. */
export const receiptItemSchema = z.object({
  label: z.string().describe('The name of the line as printed.'),
  quantity: z.number().describe('The printed quantity, 1 when none is printed. Descriptive only.'),
  amount: z
    .string()
    .describe('The full line total as printed, a plain decimal string in major units such as "16.00". Never multiplied by the quantity.'),
});

/** What the model returns for a photo. Amounts are decimal strings in major units, as printed. */
export const receiptReadingSchema = z.object({
  is_receipt: z.boolean().describe('False for anything that is not a receipt or a bill.'),
  merchant: z.string().nullable().describe('The name of the merchant as printed, or null.'),
  date: z.string().nullable().describe('The date of the receipt as an ISO date, YYYY-MM-DD, or null when none is printed.'),
  currency: z.string().nullable().describe('ISO 4217 code, as printed or as worked out. Null when it cannot be told.'),
  currency_certain: z.boolean().describe('False when the currency was guessed from a shared symbol or is not shown.'),
  items: z.array(receiptItemSchema).describe('The printed lines, in order. Lines with a negative amount are left out.'),
  tax: z.string().nullable().describe('Tax as printed, or null.'),
  tax_included: z.boolean().nullable().describe('True when the prices already include the tax. Null when it cannot be told.'),
  tip: z.string().nullable().describe('Tip as printed, or null.'),
  service_charge: z.string().nullable().describe('Service charge as printed, or null.'),
  discount: z.string().nullable().describe('The sum of all discounts and vouchers, as a positive amount, or null.'),
  total: z.string().nullable().describe('The final total as printed, or null when none is printed.'),
});

export type ReceiptItemReading = z.infer<typeof receiptItemSchema>;
export type ReceiptReading = z.infer<typeof receiptReadingSchema>;
