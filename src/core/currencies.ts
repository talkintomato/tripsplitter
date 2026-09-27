import { toBigInt } from './amounts.js';
import type { Amount } from './types.js';

export interface Currency {
  /** ISO 4217 code, three capital letters. */
  code: string;
  name: string;
  /** Number of decimals of the minor unit as this app handles it. */
  decimals: number;
}

/**
 * The supported currencies. This is the only place currencies are defined.
 * To add one, add a line here. The database picks the list up the next time it is opened.
 */
export const CURRENCIES = [
  { code: 'SGD', name: 'Singapore dollar', decimals: 2 },
  { code: 'MYR', name: 'Malaysian ringgit', decimals: 2 },
  { code: 'THB', name: 'Thai baht', decimals: 2 },
  // The official standard gives IDR two decimals, but receipts never show them.
  { code: 'IDR', name: 'Indonesian rupiah', decimals: 0 },
  { code: 'JPY', name: 'Japanese yen', decimals: 0 },
  { code: 'KRW', name: 'South Korean won', decimals: 0 },
  { code: 'CNY', name: 'Chinese yuan', decimals: 2 },
  { code: 'USD', name: 'US dollar', decimals: 2 },
  { code: 'GBP', name: 'Pound sterling', decimals: 2 },
  { code: 'AUD', name: 'Australian dollar', decimals: 2 },
  { code: 'NZD', name: 'New Zealand dollar', decimals: 2 },
  { code: 'EUR', name: 'Euro', decimals: 2 },
] as const satisfies ReadonlyArray<Currency>;

/** Union of the supported codes: 'SGD' | 'MYR' | ... */
export type CurrencyCode = (typeof CURRENCIES)[number]['code'];

/** Home currency of a new trip unless another is chosen. */
export const DEFAULT_HOME_CURRENCY: CurrencyCode = 'SGD';

const BY_CODE: ReadonlyMap<string, Currency> = new Map(CURRENCIES.map((c) => [c.code, c]));

/** Thrown when a currency code is not in `CURRENCIES`. */
export class UnsupportedCurrencyError extends Error {
  readonly currency: string;

  constructor(currency: unknown) {
    super(`${String(currency)} is not a supported currency. Supported: ${CURRENCIES.map((c) => c.code).join(', ')}.`);
    this.name = 'UnsupportedCurrencyError';
    this.currency = String(currency);
  }
}

/** True when the code is in `CURRENCIES`. Case-sensitive: 'sgd' is not supported. */
export function isSupportedCurrency(code: unknown): code is CurrencyCode {
  return typeof code === 'string' && BY_CODE.has(code);
}

/** The currency's entry. Throws `UnsupportedCurrencyError` for a code outside the list. */
export function getCurrency(code: string): Currency {
  const currency = BY_CODE.get(code);
  if (!currency) throw new UnsupportedCurrencyError(code);
  return currency;
}

/** Number of decimals: 2 for SGD, 0 for JPY, KRW and IDR. Throws `UnsupportedCurrencyError`. */
export function currencyDecimals(code: string): number {
  return getCurrency(code).decimals;
}

/**
 * Converts a decimal string in major units ("84.50", "84.5", "1200") to whole minor units (8450 for SGD,
 * 1200 for JPY). No floating point is used. Refuses, with RangeError: anything that is not a plain decimal
 * string (signs, spaces inside, thousands separators, exponents, a number instead of a string), more
 * decimals than the currency has ("84.505" for SGD, "1200.5" for JPY), and amounts too large for a safe integer.
 * Throws `UnsupportedCurrencyError` for a code outside the list.
 */
export function toMinorUnits(amountString: string, code: string): number {
  const decimals = currencyDecimals(code);
  if (typeof amountString !== 'string') throw new RangeError('The amount must be a decimal string, for example "84.50".');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amountString.trim());
  if (!match) throw new RangeError(`Not an amount: "${amountString}"`);
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw new RangeError(
      decimals === 0 ? `${code} has no decimals: "${amountString}"` : `${code} has ${decimals} decimals: "${amountString}"`,
    );
  }
  const minor = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`Amount too large: "${amountString}"`);
  return Number(minor);
}

/** Minor units to a plain decimal string without the code: 8450 SGD -> "84.50", 1200 JPY -> "1200". Throws `UnsupportedCurrencyError`. */
export function fromMinorUnits(minor: Amount, code: string): string {
  const decimals = currencyDecimals(code);
  const value = toBigInt(minor);
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : `.${digits.slice(-decimals)}`;
  return `${value < 0n ? '-' : ''}${whole}${fraction}`;
}

/** Minor units to display text: 8450 SGD -> "84.50 SGD", 1200 JPY -> "1200 JPY". Throws `UnsupportedCurrencyError`. */
export function formatAmount(minor: Amount, code: string): string {
  return `${fromMinorUnits(minor, code)} ${code}`;
}
