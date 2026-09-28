import { useMemo, useState, type KeyboardEvent } from 'react';
import type { ApiClient } from '../api/client';
import type { ExpenseItemInput, ExpensePreviewBody, Member } from '../api/types';
import { useServerPreview } from '../expense-form/useServerPreview';
import { Minus, Plus } from '../components/icons';
import { Avatar, Sheet } from '../components/ui';
import { money } from '../format';
import { withCount } from './changes';
import { MoneyInput } from './MoneyInput';

export interface ItemSheetProps {
  /** The item to change. Left out for a new item. */
  item?: ExpenseItemInput;
  /** The members included in the expense. */
  people: Member[];
  currency: string;
  /** To ask the server what each person pays for this line. Left out: no amounts are shown. */
  client?: ApiClient;
  payerId?: number;
  /** Called with the item as it should be. `another`: the member wants to enter the next one straight away. */
  onDone(item: ExpenseItemInput, another: boolean): void;
  onRemove?(): void;
  onCancel(): void;
}

function quantityOf(text: string): number {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

type Shares = Array<{ memberId: number; weight?: number }>;

/**
 * What the counts come to, in words. With a quantity above 1 it compares the counts with the receipt; with one of
 * something it says how the line divides. Nothing here works out money.
 */
function countLine(shares: Shares, quantity: number, people: Member[]): { text: string; warn?: string } {
  const counted = people.map((m) => ({ member: m, count: shares.find((s) => s.memberId === m.id)?.weight ?? (shares.some((s) => s.memberId === m.id) ? 1 : 0) })).filter((c) => c.count > 0);
  const assigned = counted.reduce((sum, c) => sum + c.count, 0);
  if (assigned === 0) return { text: 'Nobody chosen: shared equally by everyone.' };
  if (quantity > 1) {
    if (assigned < quantity) return { text: `${assigned} of ${quantity} assigned`, warn: `${quantity - assigned} not assigned yet` };
    if (assigned === quantity) return { text: `${assigned} of ${quantity} assigned` };
    return { text: `${assigned} assigned, the receipt shows ${quantity}` };
  }
  return { text: counted.map((c) => `${c.member.displayName} ${c.count} ${c.count === 1 ? 'part' : 'parts'}`).join(' · ') };
}

/** One line of the receipt: what it was, how many, what the line cost, and how many of it each person had. */
export function ItemSheet(props: ItemSheetProps) {
  const { item, people, currency } = props;
  const isNew = item === undefined;
  const [label, setLabel] = useState(item?.label ?? '');
  const [quantity, setQuantity] = useState(String(item?.quantity ?? 1));
  const [amount, setAmount] = useState(item?.amount ?? 0);
  const [shares, setShares] = useState<Shares>(item?.shares ?? []);
  // Counts the items entered one after another, to start each with empty fields.
  const [round, setRound] = useState(0);

  const count = (id: number): number => {
    const share = shares.find((s) => s.memberId === id);
    return share ? (share.weight ?? 1) : 0;
  };
  const setCount = (id: number, next: number): void => setShares((current) => withCount(current, id, next));
  const qty = quantityOf(quantity);
  const line = countLine(shares, qty, people);
  const assigned = people.reduce((sum, m) => sum + count(m.id), 0);

  // What each person pays for this line alone, as the server works it out: a preview of just this item.
  const asked = useMemo((): ExpensePreviewBody | null => {
    if (!props.client || props.payerId === undefined || amount <= 0 || people.length === 0) return null;
    return {
      payerId: props.payerId,
      description: '',
      merchant: null,
      expenseDate: '2000-01-01',
      total: amount,
      splitType: 'items',
      currency,
      shares: people.map((m) => ({ memberId: m.id })),
      items: [{ label: 'Item', quantity: qty, amount, shares: people.filter((m) => shares.some((s) => s.memberId === m.id)).map((m) => ({ memberId: m.id, weight: count(m.id) })) }],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, props.payerId, amount, currency, qty, people, shares]);
  const preview = useServerPreview(props.client ?? (null as unknown as ApiClient), asked);
  const each = preview.status === 'ready' ? preview.result?.amounts ?? null : null;

  const result = (): ExpenseItemInput => ({
    label: label.trim() === '' ? 'Item' : label.trim(),
    quantity: qty,
    amount,
    // In the order of the list, and only people who are included.
    shares: people.filter((m) => count(m.id) > 0).map((m) => ({ memberId: m.id, weight: count(m.id) })),
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
  };

  const title = isNew ? 'Add an item' : 'Change this item';
  return (
    <Sheet label={title} onClose={props.onCancel} className="item-sheet">
      <div onKeyDown={onKeyDown} className="item-sheet-body">
        <h2 className="sheet-title">{title}</h2>
        <label className="field">
          <span>What was it?</span>
          <input key={round} type="text" value={label} maxLength={200} placeholder="Beer, paella, dessert…" autoFocus={isNew} enterKeyHint="done" onChange={(event) => setLabel(event.target.value)} />
        </label>
        <div className="item-figures">
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
            <span className="amount-box amount-box-sm">
              <span className="amount-currency" aria-hidden="true">{currency}</span>
              <MoneyInput key={round} id="item-line-total" value={amount} currency={currency} onChange={setAmount} aria-describedby="item-line-total-hint" />
            </span>
          </div>
        </div>
        <p className="field-hint" id="item-line-total-hint">
          The line total is the price of the whole line as printed on the receipt. “How many” does not change it.
        </p>

        <fieldset className="item-people">
          <legend className="section-head">
            <span className="section-label">Who had this, and how many?</span>
          </legend>
          <div className="quick-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShares(people.map((m) => ({ memberId: m.id, weight: 1 })))}>
              Everyone 1 each
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={shares.length === 0} onClick={() => setShares([])}>
              Clear
            </button>
          </div>
          <div className="people-card">
            {people.map((member) => {
              const n = count(member.id);
              const mine = n > 0 && each?.[member.id] !== undefined ? each[member.id]! : undefined;
              return (
                <div key={member.id} className={`person count-row ${n > 0 ? '' : 'person-out'}`}>
                  <Avatar name={member.displayName} id={member.id} />
                  <span className="person-name-block">
                    <span className="person-name">{member.displayName}</span>
                    {n > 0 ? <span className="person-amount">{mine !== undefined ? money(mine, currency) : ' '}</span> : null}
                  </span>
                  <span className="stepper">
                    <button type="button" aria-label={`One less for ${member.displayName}`} disabled={n <= 0} onClick={() => setCount(member.id, n - 1)}>
                      <Minus size={16} />
                    </button>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      aria-label={`How many ${member.displayName} had`}
                      value={String(n)}
                      onFocus={(event) => event.target.select()}
                      onChange={(event) => setCount(member.id, Number(event.target.value.replace(/\D/g, '')) || 0)}
                    />
                    <button type="button" aria-label={`One more for ${member.displayName}`} onClick={() => setCount(member.id, n + 1)}>
                      <Plus size={16} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </fieldset>
        <div className="count-line" aria-live="polite">
          <p>
            {line.text}
            {line.warn ? <> · <span className="count-warn">{line.warn}</span></> : null}
          </p>
          {assigned > 0 && qty > 1 && assigned < qty ? <p className="field-hint">The full {money(amount, currency)} is split between the people chosen here.</p> : null}
        </div>

        <div className="sheet-actions">
          <button type="button" className="btn btn-primary btn-block" onClick={() => done(false)}>
            {isNew ? 'Add item' : 'Done'}
          </button>
          {isNew ? (
            <button type="button" className="btn btn-secondary btn-block" onClick={() => done(true)}>
              Add and enter another
            </button>
          ) : null}
          {props.onRemove ? (
            <button type="button" className="btn btn-danger btn-block" onClick={props.onRemove}>
              Remove this item
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-block" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  );
}
