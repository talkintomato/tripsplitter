import { useEffect, useState } from 'react';
import { amountText } from '../format';
import { cleanMoneyText, moneyInputMode, moneyValue } from './money';

export interface MoneyInputProps {
  id?: string;
  /** Minor units. */
  value: number;
  currency: string;
  onChange(value: number): void;
  invalid?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/** A field for an amount of zero or more. It only ever holds something that can be read as an amount. */
export function MoneyInput(props: MoneyInputProps) {
  const { value, currency } = props;
  const [text, setText] = useState(value === 0 ? '' : amountText(value, currency));

  // The figure was changed from outside the field, such as by "Enter the difference as a discount".
  useEffect(() => {
    setText((current) => (moneyValue(current, currency) === value ? current : value === 0 ? '' : amountText(value, currency)));
  }, [value, currency]);

  return (
    <input
      id={props.id}
      type="text"
      inputMode={moneyInputMode(currency)}
      autoComplete="off"
      value={text}
      placeholder={amountText(0, currency)}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      aria-invalid={props.invalid === true}
      onFocus={(event) => event.target.select()}
      onChange={(event) => {
        const cleaned = cleanMoneyText(event.target.value, currency);
        const next = moneyValue(cleaned, currency);
        if (next === null) return;
        setText(cleaned);
        if (next !== value) props.onChange(next);
      }}
    />
  );
}
