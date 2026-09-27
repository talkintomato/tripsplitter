import { toBigInt } from './amounts.js';
import { currencyDecimals } from './currencies.js';
import type { Amount } from './types.js';

/** Where an expense's rate came from. */
export type RateSource = 'home' | 'expense' | 'trip' | 'missing';

export interface ResolvedRate {
  /** Decimal string, or null when the source is `missing`. */
  rate: string | null;
  source: RateSource;
}

export interface ResolveRateInput {
  expenseCurrency: string;
  homeCurrency: string;
  /** Rate set on this expense by a member. Null, undefined or empty: none. */
  expenseOverride?: string | null | undefined;
  /** The trip's rate for the expense currency. Null, undefined or empty: none. */
  tripRate?: string | null | undefined;
}

/** Most decimal places a rate may have. */
export const RATE_MAX_DECIMALS = 6;

/**
 * True for a rate: a decimal string greater than zero with at most 6 decimal places and at most 12 digits
 * before the point, such as "1", "112.4" or "0.75". No sign, exponent, spaces or thousands separator.
 */
export function isValidRate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(value)) return false;
  return /[1-9]/.test(value);
}

/** A rate as an exact fraction. Throws RangeError for a rate that is not valid. */
function rateFraction(rate: string): { numerator: bigint; denominator: bigint } {
  if (!isValidRate(rate)) throw new RangeError(`Not a valid rate: ${String(rate)}`);
  const [whole = '0', fraction = ''] = rate.split('.');
  return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
}

/**
 * Picks the rate for an expense. Order: `home` (the two currencies are the same, rate "1"), then the rate
 * set on the expense, then the trip's rate, then `missing` with a null rate.
 * Throws RangeError for a rate that is given but not valid.
 */
export function resolveRate(input: ResolveRateInput): ResolvedRate {
  if (input.expenseCurrency === input.homeCurrency) return { rate: '1', source: 'home' };
  const candidates: Array<['expense' | 'trip', string | null | undefined]> = [
    ['expense', input.expenseOverride],
    ['trip', input.tripRate],
  ];
  for (const [source, rate] of candidates) {
    if (rate === null || rate === undefined || rate === '') continue;
    if (!isValidRate(rate)) throw new RangeError(`Not a valid rate: ${rate}`);
    return { rate, source };
  }
  return { rate: null, source: 'missing' };
}

/**
 * Converts minor units of the expense currency to minor units of the home currency:
 *
 *   homeMinorExact = expenseMinor × 10^homeDecimals / (rate × 10^expenseDecimals)
 *
 * worked out as an exact fraction in bigint. `rate` is the number of units of the expense currency equal
 * to 1 unit of home currency ("112.4" means 1 SGD = 112.4 JPY). 1124 JPY at "112.4" is 1000 SGD minor units.
 * `rounding`: `down` rounds toward zero, `half-up` rounds to the nearest with halves going up.
 * Throws RangeError for a negative amount or a rate that is not valid, and `UnsupportedCurrencyError`.
 */
export function convertToHome(
  expenseMinor: Amount,
  rate: string,
  expenseCurrency: string,
  homeCurrency: string,
  rounding: 'down' | 'half-up',
): bigint {
  const amount = toBigInt(expenseMinor);
  if (amount < 0n) throw new RangeError('The amount to convert cannot be negative.');
  const { numerator: rateNumerator, denominator: rateDenominator } = rateFraction(rate);
  const numerator = amount * 10n ** BigInt(currencyDecimals(homeCurrency)) * rateDenominator;
  const denominator = rateNumerator * 10n ** BigInt(currencyDecimals(expenseCurrency));
  const quotient = numerator / denominator;
  if (rounding === 'half-up' && (numerator % denominator) * 2n >= denominator) return quotient + 1n;
  return quotient;
}
