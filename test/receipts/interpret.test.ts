import { describe, expect, it } from 'vitest';
import { buildReceiptPrompt, draftMessage, parsePrintedAmount, planDraft, realDate, type DraftPlan } from '../../src/receipts/index.js';
import { CURRENCIES } from '../../src/core/index.js';
import { reading } from './harness.js';

const plan = (over: Parameters<typeof reading>[0] = {}, home: 'SGD' | 'JPY' = 'SGD'): DraftPlan => {
  const result = planDraft(reading(over), home, 1, [1, 2, 3]);
  if (result.kind !== 'draft') throw new Error('Expected a draft.');
  return result;
};

describe('parsePrintedAmount', () => {
  it('converts to minor units for SGD and for JPY', () => {
    expect(parsePrintedAmount('84.50', 'SGD')).toEqual({ minor: 8450, negative: false });
    expect(parsePrintedAmount('84.5', 'SGD')).toEqual({ minor: 8450, negative: false });
    expect(parsePrintedAmount('84', 'SGD')).toEqual({ minor: 8400, negative: false });
    expect(parsePrintedAmount('1200', 'JPY')).toEqual({ minor: 1200, negative: false });
  });

  it('rounds half up to the decimals of the currency', () => {
    expect(parsePrintedAmount('84.50', 'JPY')?.minor).toBe(85);
    expect(parsePrintedAmount('84.49', 'JPY')?.minor).toBe(84);
    expect(parsePrintedAmount('1200.00', 'JPY')?.minor).toBe(1200);
    expect(parsePrintedAmount('0.995', 'SGD')?.minor).toBe(100);
    expect(parsePrintedAmount('0.994', 'SGD')?.minor).toBe(99);
  });

  it('reads signs, symbols and separators', () => {
    expect(parsePrintedAmount('-10.00', 'SGD')).toEqual({ minor: 1000, negative: true });
    expect(parsePrintedAmount('10.00-', 'SGD')).toEqual({ minor: 1000, negative: true });
    expect(parsePrintedAmount('(10.00)', 'SGD')).toEqual({ minor: 1000, negative: true });
    expect(parsePrintedAmount('-0.00', 'SGD')).toEqual({ minor: 0, negative: false });
    expect(parsePrintedAmount('S$ 1,284.50', 'SGD')?.minor).toBe(128450);
    expect(parsePrintedAmount('¥12,000', 'JPY')?.minor).toBe(1200000 / 100);
    expect(parsePrintedAmount('84,50', 'SGD')?.minor).toBe(8450);
  });

  it('gives null for text that is not an amount', () => {
    for (const text of ['', 'free', '1.2.3', '12,34,56', '--5']) expect(parsePrintedAmount(text, 'SGD')).toBeNull();
    expect(parsePrintedAmount('99999999999999999999', 'SGD')).toBeNull();
  });
});

describe('planDraft', () => {
  it('is unreadable without a total, with a total of zero, or when it is not a receipt', () => {
    expect(planDraft(reading({ total: null }), 'SGD', 1, [1])).toEqual({ kind: 'unreadable' });
    expect(planDraft(reading({ total: '0.00' }), 'SGD', 1, [1])).toEqual({ kind: 'unreadable' });
    expect(planDraft(reading({ total: 'n/a' }), 'SGD', 1, [1])).toEqual({ kind: 'unreadable' });
    expect(planDraft(reading({ is_receipt: false }), 'SGD', 1, [1])).toEqual({ kind: 'unreadable' });
  });

  it('keeps the line total of an item with quantity 2', () => {
    const p = plan({ items: [{ label: 'Beer x2', quantity: 2, amount: '16.00' }], total: '16.00' });
    expect(p.items).toEqual([{ label: 'Beer x2', quantity: 2, amount: 1600 }]);
    expect(p.itemsDropped).toBe(false);
  });

  it('moves a negative line into the discount', () => {
    const p = plan({
      items: [
        { label: 'Paella', quantity: 1, amount: '60.00' },
        { label: 'Promo', quantity: 1, amount: '-5.00' },
      ],
      total: '55.00',
    });
    expect(p.discount).toBe(500);
    expect(p.items.map((i) => i.label)).toEqual(['Paella']);
  });

  it('does not count a negative line twice when the model put it in the discount as well', () => {
    const p = plan({
      items: [
        { label: 'Paella', quantity: 1, amount: '60.00' },
        { label: 'Promo', quantity: 1, amount: '-5.00' },
      ],
      discount: '5.00',
      total: '55.00',
    });
    expect(p.discount).toBe(500);
    expect(p.items).toHaveLength(1);
    expect(p.itemsDropped).toBe(false);
  });

  it('adds tax on top unless it is included', () => {
    const items = [{ label: 'Paella', quantity: 1, amount: '60.00' }];
    expect(plan({ items, tax: '5.40', tax_included: false, total: '65.40' }).items).toHaveLength(1);
    expect(plan({ items, tax: '5.40', tax_included: null, total: '65.40' })).toMatchObject({ taxIncluded: false, tax: 540 });
    expect(plan({ items, tax: '5.40', tax_included: true, total: '60.00' })).toMatchObject({ taxIncluded: true, itemsDropped: false });
    expect(plan({ items, tax: '5.40', tax_included: true, total: '65.40' })).toMatchObject({ items: [], itemsDropped: true });
  });

  it('counts tip and service charge', () => {
    const p = plan({ items: [{ label: 'Paella', quantity: 1, amount: '60.00' }], service_charge: '6.00', tip: '4.00', total: '70.00' });
    expect(p).toMatchObject({ serviceCharge: 600, tip: 400, itemsDropped: false });
    expect(p.items).toHaveLength(1);
  });

  it('drops the items when one amount cannot be read', () => {
    const p = plan({ items: [{ label: 'Paella', quantity: 1, amount: 'sixty' }], total: '60.00' });
    expect(p).toMatchObject({ total: 6000, items: [], itemsDropped: true });
  });

  it('does not say the items did not match when the receipt lists none', () => {
    expect(plan({ items: [], total: '60.00' })).toMatchObject({ total: 6000, items: [], itemsDropped: false });
  });

  it('follows the currency table', () => {
    expect(plan({ currency: 'THB', currency_certain: true })).toMatchObject({ currency: 'THB', currencyNeedsReview: false, unsupportedCurrency: null });
    expect(plan({ currency: 'usd', currency_certain: false })).toMatchObject({ currency: 'USD', currencyNeedsReview: true, unsupportedCurrency: null });
    expect(plan({ currency: null, currency_certain: false })).toMatchObject({ currency: 'SGD', currencyNeedsReview: true, unsupportedCurrency: null });
    expect(plan({ currency: 'CHF', currency_certain: true })).toMatchObject({ currency: 'SGD', currencyNeedsReview: true, unsupportedCurrency: 'CHF' });
    expect(plan({ currency: 'CHF', currency_certain: true }, 'JPY')).toMatchObject({ currency: 'JPY', total: 85, unsupportedCurrency: 'CHF' });
    expect(plan({ currency: 'euros, probably', currency_certain: false })).toMatchObject({ currency: 'SGD', currencyNeedsReview: true, unsupportedCurrency: null });
  });

  it('keeps only a real date', () => {
    expect(realDate('2026-09-26')).toBe('2026-09-26');
    expect(realDate('2026-09-26T19:30:00')).toBe('2026-09-26');
    expect(realDate('2026-02-30')).toBeNull();
    expect(realDate('26/09/2026')).toBeNull();
    expect(realDate(null)).toBeNull();
  });
});

describe('draftMessage', () => {
  it('puts the extra lines in order', () => {
    const text = draftMessage({
      merchant: null,
      description: '',
      total: 1200,
      currency: 'JPY',
      itemCount: 0,
      payerName: 'Ana',
      itemsDropped: true,
      currencyNeedsReview: true,
      unsupportedCurrency: null,
      rateMissing: true,
      duplicate: { merchant: 'Ichiran', total: 1200, currency: 'JPY', byName: 'Sam' },
    });
    expect(text.split('\n')).toEqual([
      'Receipt · 1200 JPY',
      'Paid by Ana',
      "I couldn't match the items to the total, so check them.",
      'Check the currency before saving.',
      "Couldn't look up an exchange rate. Open to set it.",
      'This looks like one already added: Ichiran, 1200 JPY, by Sam.',
    ]);
  });
});

describe('prompt', () => {
  it('holds what the PRD asks for', () => {
    const prompt = buildReceiptPrompt();
    for (const currency of CURRENCIES) expect(prompt).toContain(currency.code);
    expect(prompt).toContain('Do not calculate');
    expect(prompt).toContain('is_receipt false');
    expect(prompt).toContain('currency_certain to false');
    expect(prompt).toContain('negative amount');
    expect(prompt).toContain('"$"');
    expect(prompt).toContain('"¥"');
  });
});
