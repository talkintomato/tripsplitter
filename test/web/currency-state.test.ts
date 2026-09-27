import { describe, expect, it } from 'vitest';
import { changeCurrency, newExpenseState, toExpenseInput } from '../../web/src/expense-form/formState';

const state = () => ({
  ...newExpenseState({ members: [], meId: 1, currency: 'SGD' }),
  amountText: '84.50', items: [{ label: 'Lunch', amount: 8449, quantity: 2 }],
  tax: 150, tip: 249, serviceCharge: 350, discount: 50,
});

describe('changing expense currency', () => {
  it('rescales every SGD figure to JPY, rounding half up', () => {
    const original = state();
    const result = changeCurrency(original, 'JPY');
    expect(result).toMatchObject({ currency: 'JPY', amountText: '85', items: [{ amount: 84, quantity: 2 }], tax: 2, tip: 2, serviceCharge: 4, discount: 1 });
    expect(original).toEqual(state());
  });
  it('rescales every JPY figure to SGD without changing its displayed value', () => {
    const original = { ...state(), currency: 'JPY', amountText: '85', items: [{ label: 'Lunch', amount: 84 }], tax: 2, tip: 2, serviceCharge: 4, discount: 1 };
    expect(changeCurrency(original, 'SGD')).toMatchObject({ amountText: '85.00', items: [{ amount: 8400 }], tax: 200, tip: 200, serviceCharge: 400, discount: 100 });
  });
  it('keeps whole numbers on a round trip and does not restore discarded fractions', () => {
    const result = changeCurrency(changeCurrency(state(), 'JPY'), 'SGD');
    expect(result).toMatchObject({ amountText: '85.00', tax: 200, tip: 200, serviceCharge: 400, discount: 100 });
    const whole = { ...state(), amountText: '84.00', items: [], tax: 100, tip: 200, serviceCharge: 300, discount: 0 };
    expect(changeCurrency(changeCurrency(whole, 'JPY'), 'SGD')).toMatchObject({ amountText: '84.00', items: [], tax: 100, tip: 200, serviceCharge: 300, discount: 0 });
  });
  it('preserves text between currencies with the same decimals and confirms receipt currency', () => {
    const result = changeCurrency({ ...state(), currencyNeedsReview: true }, 'THB');
    expect(result.amountText).toBe('84.50');
    expect(result.currencyNeedsReview).toBe(false);
    expect(toExpenseInput(result, 8450)).toMatchObject({ currency: 'THB' });
    expect(toExpenseInput(result, 8450)).not.toHaveProperty('rateOverride');
  });
  it('keeps blank input and refuses invalid or overflowing figures without mutating state', () => {
    expect(changeCurrency({ ...state(), amountText: '' }, 'JPY').amountText).toBe('');
    expect(() => changeCurrency({ ...state(), amountText: 'bad' }, 'JPY')).toThrow('Check the amount');
    expect(() => changeCurrency({ ...state(), currency: 'JPY', amountText: '1', tip: Number.MAX_SAFE_INTEGER }, 'SGD')).toThrow('too large');
  });
});
