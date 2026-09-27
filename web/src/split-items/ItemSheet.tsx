import { useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ExpenseItemInput, Member } from '../api/types';
import { MoneyInput } from './MoneyInput';

export interface ItemSheetProps {
  /** The item to change. Left out for a new item. */
  item?: ExpenseItemInput;
  /** The members included in the expense. */
  people: Member[];
  currency: string;
  /** Called with the item as it should be. `another`: the member wants to enter the next one straight away. */
  onDone(item: ExpenseItemInput, another: boolean): void;
  onRemove?(): void;
  onCancel(): void;
}

function quantityOf(text: string): number {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/** One line of the receipt: what it was, how many, what the line cost, and who had it. */
export function ItemSheet(props: ItemSheetProps) {
  const { item, people, currency } = props;
  const isNew = item === undefined;
  const [label, setLabel] = useState(item?.label ?? '');
  const [quantity, setQuantity] = useState(String(item?.quantity ?? 1));
  const [amount, setAmount] = useState(item?.amount ?? 0);
  const [shares, setShares] = useState(item?.shares ?? []);
  // Counts the items entered one after another, to start each with empty fields.
  const [round, setRound] = useState(0);

  const ticked = new Set(shares.map((s) => s.memberId));
  const toggle = (id: number): void => setShares((current) => (current.some((s) => s.memberId === id) ? current.filter((s) => s.memberId !== id) : [...current, { memberId: id }]));

  const result = (): ExpenseItemInput => ({
    label: label.trim() === '' ? 'Item' : label.trim(),
    quantity: quantityOf(quantity),
    amount,
    // In the order of the list, and only people who are included.
    shares: people.filter((m) => ticked.has(m.id)).map((m) => shares.find((s) => s.memberId === m.id)!),
  });

  const done = (another: boolean): void => {
    props.onDone(result(), another);
    if (!another) return;
    setLabel('');
    setQuantity('1');
    setAmount(0);
    setShares([]);
    setRound((n) => n + 1);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
      event.preventDefault();
      done(false);
    }
    if (event.key === 'Escape') props.onCancel();
  };

  const title = isNew ? 'Add an item' : 'Change this item';
  return createPortal(
    <div className="sheet-backdrop" onClick={props.onCancel}>
      <div className="sheet item-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <h2>{title}</h2>
        <label className="field">
          <span>What was it?</span>
          <input key={round} type="text" value={label} maxLength={200} placeholder="Beer, paella, dessert…" autoFocus={isNew} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <div className="field-pair item-figures">
          <label className="field item-quantity">
            <span>How many</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={quantity}
              onFocus={(event) => event.target.select()}
              onChange={(event) => setQuantity(event.target.value.replace(/\D/g, '').slice(0, 3))}
            />
          </label>
          <div className="field">
            <label htmlFor="item-line-total">Line total</label>
            <span className="amount-row">
              <MoneyInput key={round} id="item-line-total" value={amount} currency={currency} onChange={setAmount} aria-describedby="item-line-total-hint" />
              <span className="currency">{currency}</span>
            </span>
          </div>
        </div>
        <p className="hint small" id="item-line-total-hint">
          The line total is the price of the whole line as printed on the receipt. “How many” does not change it.
        </p>

        <fieldset className="people">
          <legend>
            <span>Who had this?</span>
            {ticked.size > 0 ? (
              <button type="button" className="link" onClick={() => setShares([])}>
                Everyone
              </button>
            ) : null}
          </legend>
          {people.map((member) => (
            <label key={member.id} className="person">
              <input type="checkbox" checked={ticked.has(member.id)} onChange={() => toggle(member.id)} />
              <span className="person-name">{member.displayName}</span>
            </label>
          ))}
        </fieldset>
        <p className="hint small">{ticked.size === 0 ? 'Nobody ticked: everyone shares it.' : ticked.size === 1 ? 'One person pays for it.' : `${ticked.size} people share it equally.`}</p>

        <div className="sheet-actions">
          <button type="button" className="button" onClick={() => done(false)}>
            {isNew ? 'Add item' : 'Done'}
          </button>
          {isNew ? (
            <button type="button" className="button button-quiet" onClick={() => done(true)}>
              Add and enter another
            </button>
          ) : null}
          {props.onRemove ? (
            <button type="button" className="button button-quiet danger" onClick={props.onRemove}>
              Remove this item
            </button>
          ) : null}
          <button type="button" className="button button-quiet" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
