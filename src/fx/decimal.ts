/** Most decimal places a rate may carry, the same limit as `src/core/rates.ts`. */
export const RATE_DECIMALS = 6;

/** A number as JSON writes it: optional sign, digits, optional fraction, optional exponent. */
const JSON_NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const LITERAL = new RegExp(`^(-)?(\\d+)(?:\\.(\\d+))?(?:[eE]([+-]?\\d+))?$`);

/** Exponents beyond this are not exchange rates, and would only build very long strings. */
const MAX_EXPONENT = 30;

/**
 * Turns the text of a JSON number into a rate string: plain decimal notation, cut (not rounded)
 * to 6 decimal places, without trailing zeros in the fraction. Works on the characters only, so
 * no digit passes through floating point.
 *
 * Returns null for anything that is not a number above zero, including a value that becomes
 * zero once cut to 6 places.
 */
export function normaliseRateLiteral(literal: string): string | null {
  const match = LITERAL.exec(literal.trim());
  if (!match) return null;
  const [, sign, whole = '', fraction = '', exponentText] = match;
  if (sign) return null;

  let integerPart = whole;
  let fractionPart = fraction;

  if (exponentText !== undefined) {
    const exponent = Number.parseInt(exponentText, 10);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) return null;
    const digits = whole + fraction;
    const point = whole.length + exponent;
    if (point <= 0) {
      integerPart = '0';
      fractionPart = '0'.repeat(-point) + digits;
    } else if (point >= digits.length) {
      integerPart = digits + '0'.repeat(point - digits.length);
      fractionPart = '';
    } else {
      integerPart = digits.slice(0, point);
      fractionPart = digits.slice(point);
    }
  }

  integerPart = integerPart.replace(/^0+(?=\d)/, '');
  fractionPart = fractionPart.slice(0, RATE_DECIMALS).replace(/0+$/, '');

  if (/^0*$/.test(integerPart) && fractionPart === '') return null;
  return fractionPart === '' ? integerPart : `${integerPart}.${fractionPart}`;
}

/**
 * Finds the text of the number given for `currency` inside the `rates` object of a Frankfurter
 * response body. Returns null when it is not there or is not written as a number.
 *
 * The `rates` object is flat (codes to numbers), so it ends at the first closing brace.
 */
export function extractRateLiteral(body: string, currency: string): string | null {
  const start = /"rates"\s*:\s*\{/.exec(body);
  if (!start) return null;
  const from = start.index + start[0].length;
  const end = body.indexOf('}', from);
  if (end === -1) return null;
  const inner = body.slice(from, end);
  const entry = new RegExp(`(?:^|,)\\s*"${currency}"\\s*:\\s*(${JSON_NUMBER})\\s*(?:,|$)`).exec(inner);
  return entry?.[1] ?? null;
}
