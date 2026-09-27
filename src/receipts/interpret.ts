import { currencyDecimals, isSupportedCurrency, toMinorUnits, validateExpense, type CurrencyCode } from '../core/index.js';
import type { ReceiptReading } from './schema.js';

export interface ParsedAmount {
  /** Minor units, zero or more. */
  minor: number;
  /** True when the printed amount was below zero. */
  negative: boolean;
}

/**
 * A printed amount as minor units of `currency`. More decimals than the currency has are rounded half up,
 * so "84.50" is 85 for JPY. Tolerates a sign, brackets for a negative amount, a currency symbol, thousands
 * separators and a decimal comma. Null when the text is not an amount.
 */
export function parsePrintedAmount(raw: string, currency: string): ParsedAmount | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[^0-9.,\-−–]/g, '');
  if (/^[-−–]/.test(text) || /[-−–]$/.test(text)) {
    negative = true;
    text = text.replace(/^[-−–]|[-−–]$/g, '');
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(text)) text = text.replace(/\./g, '').replace(',', '.');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;

  const decimals = currencyDecimals(currency);
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  let value = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, '0'));
  if ((fraction[decimals] ?? '0') >= '5') value += 1n;
  const digits = value.toString().padStart(decimals + 1, '0');
  const plain = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  try {
    const minor = toMinorUnits(plain, currency);
    return { minor, negative: negative && minor !== 0 };
  } catch {
    return null;
  }
}

export interface DraftItem {
  label: string;
  quantity: number;
  amount: number;
}

export interface DraftPlan {
  kind: 'draft';
  currency: CurrencyCode;
  currencyNeedsReview: boolean;
  /** The code printed on the receipt when it is not a supported one. */
  unsupportedCurrency: string | null;
  merchant: string | null;
  /** From the receipt, null when it has none or it is not a real date. */
  date: string | null;
  total: number;
  tax: number;
  taxIncluded: boolean;
  tip: number;
  serviceCharge: number;
  discount: number;
  /** Empty when the items did not match the total. */
  items: DraftItem[];
  /** True when the model returned items and they were left out because they do not add up. */
  itemsDropped: boolean;
}

export type ReceiptPlan = DraftPlan | { kind: 'unreadable' };

const LABEL_MAX = 200;

function cleanLine(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** `YYYY-MM-DD` when the text is a real date, else null. */
export function realDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (year < 2000) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Works out the draft for a reading. Changes nothing.
 * `memberIds` are the members the draft will include; they are needed to check the items as an items split.
 */
export function planDraft(reading: ReceiptReading, homeCurrency: CurrencyCode, payerId: number, memberIds: number[]): ReceiptPlan {
  if (!reading.is_receipt || reading.total === null) return { kind: 'unreadable' };

  const printed = (reading.currency ?? '').trim().toUpperCase();
  let currency: CurrencyCode = homeCurrency;
  let currencyNeedsReview = true;
  let unsupportedCurrency: string | null = null;
  if (isSupportedCurrency(printed)) {
    currency = printed;
    currencyNeedsReview = !reading.currency_certain;
  } else if (/^[A-Z]{3}$/.test(printed)) {
    unsupportedCurrency = printed;
  }

  const total = parsePrintedAmount(reading.total, currency);
  if (!total || total.negative || total.minor <= 0) return { kind: 'unreadable' };

  let figuresOk = true;
  const adjustment = (raw: string | null): number => {
    if (raw === null || raw.trim() === '') return 0;
    const parsed = parsePrintedAmount(raw, currency);
    if (!parsed) {
      figuresOk = false;
      return 0;
    }
    return parsed.minor;
  };
  const tax = adjustment(reading.tax);
  const tip = adjustment(reading.tip);
  const serviceCharge = adjustment(reading.service_charge);
  const printedDiscount = adjustment(reading.discount);

  // A line with a negative amount is a discount, not an item.
  const items: DraftItem[] = [];
  let negativeLines = 0;
  for (const line of reading.items) {
    const parsed = parsePrintedAmount(line.amount, currency);
    if (!parsed) {
      figuresOk = false;
      continue;
    }
    if (parsed.negative) {
      negativeLines += parsed.minor;
      continue;
    }
    const quantity = typeof line.quantity === 'number' && Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 1;
    items.push({ label: cleanLine(line.label, LABEL_MAX) || 'Item', quantity, amount: parsed.minor });
  }

  const taxIncluded = reading.tax_included ?? false;
  const shares = memberIds.map((memberId) => ({ memberId, weight: 1 }));
  const passes = (discount: number): boolean =>
    figuresOk &&
    items.length <= 500 &&
    validateExpense(
      { payerId, total: total.minor, tax, taxIncluded, tip, serviceCharge, discount, splitType: 'items' },
      items.map((item, index) => ({ id: index, amount: item.amount })),
      shares,
    ).length === 0;

  // The model may have counted a negative line in `discount` already and still returned the line.
  let discount = printedDiscount + negativeLines;
  let itemsOk = passes(discount);
  if (!itemsOk && negativeLines > 0 && passes(printedDiscount)) {
    discount = printedDiscount;
    itemsOk = true;
  }

  return {
    kind: 'draft',
    currency,
    currencyNeedsReview,
    unsupportedCurrency,
    merchant: cleanLine(reading.merchant, 200) || null,
    date: realDate(reading.date),
    total: total.minor,
    tax,
    taxIncluded,
    tip,
    serviceCharge,
    discount,
    items: itemsOk ? items : [],
    itemsDropped: !itemsOk && reading.items.length > 0,
  };
}
