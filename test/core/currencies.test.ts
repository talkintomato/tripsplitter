import { describe, expect, it } from 'vitest';
import {
  CURRENCIES,
  DEFAULT_HOME_CURRENCY,
  UnsupportedCurrencyError,
  amountsToRecord,
  convertToHome,
  currencyDecimals,
  formatAmount,
  isSupportedCurrency,
  isValidRate,
  resolveRate,
  toMinorUnits,
  toSafeNumber,
} from '../../src/core/index.js';

describe('currencies', () => {
  it('lists the supported currencies with their decimals', () => {
    expect(CURRENCIES.map((c) => c.code)).toEqual(['SGD', 'MYR', 'THB', 'IDR', 'JPY', 'KRW', 'CNY', 'USD', 'GBP', 'AUD', 'NZD']);
    expect(CURRENCIES.filter((c) => c.decimals === 0).map((c) => c.code)).toEqual(['IDR', 'JPY', 'KRW']);
    expect(CURRENCIES.every((c) => c.decimals === 0 || c.decimals === 2)).toBe(true);
    expect(DEFAULT_HOME_CURRENCY).toBe('SGD');
  });

  it('an unsupported currency is refused', () => {
    expect(isSupportedCurrency('SGD')).toBe(true);
    expect(isSupportedCurrency('EUR')).toBe(false);
    expect(isSupportedCurrency('sgd')).toBe(false);
    expect(isSupportedCurrency(undefined)).toBe(false);
    expect(() => toMinorUnits('1', 'EUR')).toThrow(UnsupportedCurrencyError);
    expect(() => formatAmount(100, 'EUR')).toThrow(UnsupportedCurrencyError);
    expect(() => currencyDecimals('EUR')).toThrow(UnsupportedCurrencyError);
    expect(() => convertToHome(100, '1.5', 'EUR', 'SGD', 'down')).toThrow(UnsupportedCurrencyError);
  });

  it('converts a decimal string to minor units', () => {
    expect(toMinorUnits('84.50', 'SGD')).toBe(8450);
    expect(toMinorUnits('84.5', 'SGD')).toBe(8450);
    expect(toMinorUnits('84', 'SGD')).toBe(8400);
    expect(toMinorUnits('0.05', 'USD')).toBe(5);
    expect(toMinorUnits(' 19.99 ', 'USD')).toBe(1999);
    expect(toMinorUnits('1200', 'JPY')).toBe(1200);
    expect(toMinorUnits('1500000', 'IDR')).toBe(1500000);
    expect(toMinorUnits('45000', 'KRW')).toBe(45000);
  });

  it('refuses more decimals than the currency has, and anything that is not a decimal string', () => {
    expect(() => toMinorUnits('84.505', 'SGD')).toThrow(RangeError);
    expect(() => toMinorUnits('1200.5', 'JPY')).toThrow(RangeError);
    expect(() => toMinorUnits('1200.0', 'IDR')).toThrow(RangeError);
    for (const bad of ['12,50', '-5', '+5', '1e3', '', 'abc', '.5', '5.', '1 000']) {
      expect(() => toMinorUnits(bad, 'SGD'), bad).toThrow(RangeError);
    }
    expect(() => toMinorUnits(84.5 as unknown as string, 'SGD')).toThrow(RangeError);
    expect(() => toMinorUnits('99999999999999999999', 'SGD')).toThrow(RangeError);
  });

  it('formats amounts', () => {
    expect(formatAmount(8450, 'SGD')).toBe('84.50 SGD');
    expect(formatAmount(8450n, 'SGD')).toBe('84.50 SGD');
    expect(formatAmount(5, 'SGD')).toBe('0.05 SGD');
    expect(formatAmount(-1332n, 'SGD')).toBe('-13.32 SGD');
    expect(formatAmount(1200, 'JPY')).toBe('1200 JPY');
    expect(formatAmount(1500000, 'IDR')).toBe('1500000 IDR');
  });

  it('turns bigint amounts into numbers for JSON', () => {
    expect(toSafeNumber(8450n)).toBe(8450);
    expect(() => toSafeNumber(2n ** 60n)).toThrow(RangeError);
    expect(amountsToRecord(new Map([[1, 5n], [2, -5n]]))).toEqual({ 1: 5, 2: -5 });
  });
});

describe('rates', () => {
  it('a rate is a decimal string above zero with at most 6 decimal places', () => {
    for (const ok of ['1', '112.4', '0.75', '11500', '0.000086', '112.400000']) expect(isValidRate(ok), ok).toBe(true);
    for (const bad of ['0', '0.0', '-1', '1e3', '1,5', '', ' 1', '.5', '5.', 'abc', '0.0000001', '1.1234567', 1.5, null, undefined]) {
      expect(isValidRate(bad), String(bad)).toBe(false);
    }
  });

  it('rate order: home, expense, trip, missing', () => {
    const both = { expenseOverride: '110', tripRate: '112.4' };
    expect(resolveRate({ expenseCurrency: 'SGD', homeCurrency: 'SGD', ...both })).toEqual({ rate: '1', source: 'home' });
    expect(resolveRate({ expenseCurrency: 'JPY', homeCurrency: 'SGD', ...both })).toEqual({ rate: '110', source: 'expense' });
    expect(resolveRate({ expenseCurrency: 'JPY', homeCurrency: 'SGD', expenseOverride: null, tripRate: '112.4' })).toEqual({ rate: '112.4', source: 'trip' });
    expect(resolveRate({ expenseCurrency: 'JPY', homeCurrency: 'SGD', tripRate: '112.4' })).toEqual({ rate: '112.4', source: 'trip' });
    expect(resolveRate({ expenseCurrency: 'JPY', homeCurrency: 'SGD', expenseOverride: null, tripRate: null })).toEqual({ rate: null, source: 'missing' });
    expect(resolveRate({ expenseCurrency: 'JPY', homeCurrency: 'SGD' })).toEqual({ rate: null, source: 'missing' });
  });

  it('keeps the rate exactly as entered', () => {
    expect(resolveRate({ expenseCurrency: 'JPY', homeCurrency: 'SGD', tripRate: '112.40' }).rate).toBe('112.40');
  });

  it('throws on a rate that is given but not valid', () => {
    expect(() => resolveRate({ expenseCurrency: 'JPY', homeCurrency: 'SGD', expenseOverride: '0' })).toThrow(RangeError);
    expect(() => resolveRate({ expenseCurrency: 'JPY', homeCurrency: 'SGD', tripRate: '-2' })).toThrow(RangeError);
  });

  it('1124 JPY at 112.4 converts to exactly 10.00 SGD, and 11240 JPY to 100.00 SGD', () => {
    expect(convertToHome(1124, '112.4', 'JPY', 'SGD', 'down')).toBe(1000n);
    expect(convertToHome(1124, '112.4', 'JPY', 'SGD', 'half-up')).toBe(1000n);
    expect(convertToHome(11240, '112.4', 'JPY', 'SGD', 'down')).toBe(10000n);
    expect(convertToHome(11240n, '112.4', 'JPY', 'SGD', 'half-up')).toBe(10000n);
    expect(formatAmount(convertToHome(11240, '112.4', 'JPY', 'SGD', 'down'), 'SGD')).toBe('100.00 SGD');
  });

  it('divides by the rate and minds the decimals of both currencies', () => {
    // 1 SGD = 0.75 USD: 7.50 USD is 10.00 SGD.
    expect(convertToHome(750, '0.75', 'USD', 'SGD', 'down')).toBe(1000n);
    // 1 SGD = 11500 IDR: 150000 IDR is 13.043... SGD.
    expect(convertToHome(150000, '11500', 'IDR', 'SGD', 'down')).toBe(1304n);
    // Home JPY. 1 JPY = 0.0089 SGD: 10.00 SGD is 1123.59... JPY.
    expect(convertToHome(1000, '0.0089', 'SGD', 'JPY', 'down')).toBe(1123n);
    expect(convertToHome(1000, '0.0089', 'SGD', 'JPY', 'half-up')).toBe(1124n);
    // Both without decimals. 1 JPY = 9.5 KRW.
    expect(convertToHome(9500, '9.5', 'KRW', 'JPY', 'down')).toBe(1000n);
    expect(convertToHome(1234, '1', 'SGD', 'SGD', 'down')).toBe(1234n);
  });

  it('rounds down, or half up', () => {
    // 100 JPY / 112.4 = 0.88967... SGD
    expect(convertToHome(100, '112.4', 'JPY', 'SGD', 'down')).toBe(88n);
    expect(convertToHome(100, '112.4', 'JPY', 'SGD', 'half-up')).toBe(89n);
    // Exactly half: 1 JPY at 200 is 0.005 SGD, which is 0.5 minor units.
    expect(convertToHome(1, '200', 'JPY', 'SGD', 'down')).toBe(0n);
    expect(convertToHome(1, '200', 'JPY', 'SGD', 'half-up')).toBe(1n);
  });

  it('is exact where floating point is not', () => {
    // In floating point 3 / 0.3 is 9.999999999999998.
    expect(convertToHome(3, '0.3', 'USD', 'SGD', 'down')).toBe(10n);
    expect(convertToHome(9007199254740991, '1.000001', 'USD', 'SGD', 'down')).toBe(9007190247550743n);
  });

  it('refuses a bad rate or amount', () => {
    expect(() => convertToHome(100, '0', 'JPY', 'SGD', 'down')).toThrow(RangeError);
    expect(() => convertToHome(100, '1.1234567', 'JPY', 'SGD', 'down')).toThrow(RangeError);
    expect(() => convertToHome(-100, '112.4', 'JPY', 'SGD', 'down')).toThrow(RangeError);
    expect(() => convertToHome(10.5, '112.4', 'JPY', 'SGD', 'down')).toThrow(RangeError);
  });
});
