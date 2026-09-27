import { currencyDecimals, toMinorUnits } from '../../../src/core/currencies';

function decimalsOf(currency: string): number {
  try {
    return currencyDecimals(currency);
  } catch {
    return 2;
  }
}

/** What was typed, with everything that cannot be part of an amount taken out. A comma counts as a dot. */
export function cleanMoneyText(text: string, currency: string): string {
  const decimals = decimalsOf(currency);
  const plain = text.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const dot = plain.indexOf('.');
  if (dot === -1) return plain.slice(0, 12);
  if (decimals === 0) return plain.slice(0, dot).slice(0, 12);
  const whole = plain.slice(0, dot).slice(0, 12);
  return `${whole}.${plain.slice(dot + 1).replace(/\./g, '').slice(0, decimals)}`;
}

/** Minor units of a cleaned text. An empty field is 0. Null when it still cannot be read. */
export function moneyValue(text: string, currency: string): number | null {
  let plain = text.endsWith('.') ? text.slice(0, -1) : text;
  if (plain === '') return 0;
  if (plain.startsWith('.')) plain = `0${plain}`;
  try {
    return toMinorUnits(plain, currency);
  } catch {
    return null;
  }
}

export function moneyInputMode(currency: string): 'numeric' | 'decimal' {
  return decimalsOf(currency) === 0 ? 'numeric' : 'decimal';
}
