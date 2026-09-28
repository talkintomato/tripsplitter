import { useState } from 'react';
import { messageOf } from '../api/client';
import type { ExpenseItemInput, ExpenseProblem } from '../api/types';
import type { SplitBodyProps } from '../expense-form/registry';
import { amountText, money } from '../format';
import {
  addDifferenceAsOther,
  addItem,
  assignedTo,
  removeItem,
  replaceItem,
  toggleIncluded,
  countOf,
  stepOnItem,
  whoText as itemWho,
} from './changes';
import { ItemSheet } from './ItemSheet';
import { Check, Minus, More, Plus } from '../components/icons';
import { Avatar } from '../components/ui';
import { MoneyInput } from './MoneyInput';
import './items.css';

const FIGURES = [
  { field: 'tip', label: 'Tip' },
  { field: 'serviceCharge', label: 'Service charge' },
  { field: 'discount', label: 'Discount' },
] as const;

function Problems(props: { problems: ExpenseProblem[] }) {
  if (props.problems.length === 0) return null;
  return (
    <>
      {props.problems.map((problem) => (
        <p key={`${problem.field}-${problem.code}`} className="problem" role="alert">
          {problem.message}
        </p>
      ))}
    </>
  );
}

/** A receipt split line by line. Every amount shown is the server's answer for what is on the screen. */
export function ItemsSplit(props: SplitBodyProps) {
  const { state, update, members, total, currency, amounts, disabled } = props;
  const pending = props.pending === true;
  const [painter, setPainter] = useState<number | null>(null);
  const [open, setOpen] = useState<number | 'new' | null>(null);
  const [choosing, setChoosing] = useState(false);

  const includedIds = members.filter((m) => state.included.includes(m.id)).map((m) => m.id);
  const people = members.filter((m) => includedIds.includes(m.id));
  const painting = painter !== null && includedIds.includes(painter) ? painter : null;
  const painterName = people.find((m) => m.id === painting)?.displayName ?? '';
  const nameOf = (id: number): string => people.find((m) => m.id === id)?.displayName ?? '';

  const problems = props.problems;
  const mismatch = problems.find((p) => p.code === 'total_mismatch' && typeof p.difference === 'number');
  const difference = mismatch?.difference ?? 0;
  const at = (field: ExpenseProblem['field']): ExpenseProblem[] => problems.filter((p) => p.field === field && p !== mismatch);
  // An empty list has its own words.
  const itemProblems = at('items').filter((p) => p.code !== 'no_items');
  // A missing amount is said by the box about the difference, and by the empty list while there is no item.
  const totalProblems = at('total').filter((p) => !(p.code === 'total_not_positive' && (mismatch || state.items.length === 0)));
  const newTotal = props.corrections?.total ?? null;
  const noTotal = total === 0;

  const whoText = (item: ExpenseItemInput): string => itemWho(item, includedIds, nameOf);

  const tapItem = (index: number): void => {
    if (painting === null) setOpen(index);
    else update(stepOnItem(state.items, index, painting, 1));
  };

  const openItem = typeof open === 'number' ? state.items[open] : undefined;

  return (
    <fieldset className="items-split" disabled={disabled}>
      <legend className="visually-hidden">Split by item</legend>

      <section className="section">
        <div className="section-head">
          <span className="section-label">Who was there</span>
          <button type="button" className="link-btn small" aria-expanded={choosing} onClick={() => setChoosing((on) => !on)}>
            {choosing ? 'Done' : 'Change'}
          </button>
        </div>
        {choosing ? (
          <div className="people-card">
            {members.map((member) => (
              <label key={member.id} className={`person ${state.included.includes(member.id) ? '' : 'person-out'}`}>
                <input type="checkbox" className="tick" checked={state.included.includes(member.id)} onChange={() => update(toggleIncluded(state, member.id))} />
                <Avatar name={member.displayName} id={member.id} />
                <span className="person-name">{member.displayName}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="items-there">{people.length === 0 ? 'Nobody yet' : people.map((m) => m.displayName).join(', ')}</p>
        )}
        <Problems problems={at('shares')} />
      </section>

      <section className="section">
        <div className={`paint ${painting !== null ? 'paint-on' : ''}`}>
          <p className="paint-how" aria-live="polite">
            {painting !== null ? (
              <>
                <strong>Now tap everything {painterName} had.</strong>
                <button type="button" className="btn btn-primary btn-sm paint-stop" onClick={() => setPainter(null)}>
                  Finished
                </button>
              </>
            ) : state.items.length === 0 ? (
              <span className="section-label">Items</span>
            ) : (
              <strong>Tap a name, then tap everything that person had.</strong>
            )}
          </p>
          {painting !== null ? <p className="field-hint paint-hint">Each tap adds one. Use − on a line to take one away.</p> : null}
          {state.items.length > 0 && people.length > 0 ? (
            <div className="paint-people" role="group" aria-label="Pick a person">
              {people.map((member) => {
                const amount = amounts?.[member.id];
                return (
                  <button
                    key={member.id}
                    type="button"
                    className={`paint-person ${painting === member.id ? 'on' : ''}`}
                    aria-pressed={painting === member.id}
                    onClick={() => setPainter(painting === member.id ? null : member.id)}
                  >
                    <span className="paint-name">{member.displayName}</span>
                    <span className={`paint-amount ${pending ? 'stale' : ''}`}>{amount !== undefined ? money(amount, currency) : '—'}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        {state.items.length === 0 ? (
          <p className="list-empty">Nothing here yet. Add each line of the receipt.</p>
        ) : (
          <ul className={`list-card items-list ${painting !== null ? 'painting' : ''}`}>
            {state.items.map((item, index) => {
              const count = painting !== null && assignedTo(item, includedIds).includes(painting) ? countOf(item, painting) : 0;
              const mine = count > 0;
              const label = `${item.label}${(item.quantity ?? 1) !== 1 ? ` ×${item.quantity}` : ''}`;
              const shared = assignedTo(item, includedIds).length === 0;
              return (
                <li key={index} className={`item-row ${mine ? 'item-mine' : ''}`}>
                  <button type="button" className="item-main" {...(painting !== null ? { 'aria-pressed': mine } : {})} onClick={() => tapItem(index)}>
                    {painting !== null ? (
                      <span className={`item-mark ${mine ? 'on' : ''}`} aria-hidden="true">
                        {count > 1 ? count : mine ? <Check size={14} /> : null}
                      </span>
                    ) : null}
                    <span className="item-text">
                      <span className="item-label">{label}</span>
                      <span className={`item-who ${shared ? 'item-who-all' : ''}`}>{whoText(item)}</span>
                    </span>
                    <span className="row-amount">{money(item.amount, currency)}</span>
                  </button>
                  {painting !== null && mine ? (
                    <button type="button" className="item-side" aria-label={`One less ${item.label} for ${painterName}`} onClick={() => update(stepOnItem(state.items, index, painting, -1))}>
                      <Minus size={16} />
                    </button>
                  ) : null}
                  {painting !== null ? (
                    <button type="button" className="item-side item-edit" aria-label={`Change ${item.label}`} onClick={() => setOpen(index)}>
                      <More size={18} />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <Problems problems={itemProblems} />
        <button type="button" className="btn btn-secondary btn-block" onClick={() => setOpen('new')}>
          <Plus size={18} /> Add an item
        </button>
        {state.items.length > 0 && painting === null ? <p className="field-hint center">Tap an item to change it, or to set how many each person had.</p> : null}
      </section>

      {mismatch ? (
        <div className="banner banner-warn difference" role="alert">
          <div className="banner-body">
            {noTotal ? (
              <p>
                <strong>No amount entered yet.</strong> The items, tax and tip add up to {money(-difference, currency)}.
              </p>
            ) : difference > 0 ? (
              <p>
                <strong>The amount is {money(difference, currency)} more than the items add up to.</strong> Something is missing from the list.
              </p>
            ) : (
              <p>
                <strong>The amount is {money(-difference, currency)} less than the items add up to.</strong> Maybe there was a discount.
              </p>
            )}
            <div className="difference-choices">
              {newTotal !== null ? (
                <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => update({ amountText: amountText(newTotal, currency) })}>
                  {noTotal ? 'Use' : 'Change the amount to'} {money(newTotal, currency)}
                </button>
              ) : null}
              {difference > 0 ? (
                <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => update(addDifferenceAsOther(state, difference))}>
                  Add {money(difference, currency)} as “Other”, shared by everyone
                </button>
              ) : null}
              {difference < 0 && !noTotal && props.corrections?.discount != null ? (
                <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => update({ discount: props.corrections!.discount! })}>
                  Enter {money(-difference, currency)} as a discount
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <Problems problems={totalProblems} />

      {props.beforeShares}

      <section className="section">
        <div className="section-head">
          <span className="section-label">Each person pays</span>
          {pending ? <span className="field-hint">Working it out…</span> : null}
        </div>
        {props.previewError !== undefined ? (
          <div className="banner banner-error" role="alert">
            <div className="banner-body">
              <p>{messageOf(props.previewError)}</p>
              <p className="small">Nothing can be saved until the shares are worked out.</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => props.retryPreview?.()}>
                Try again
              </button>
            </div>
          </div>
        ) : amounts !== null && problems.length === 0 ? (
          <ul className={`people-card shares ${pending ? 'stale' : ''}`} aria-label="Each person pays">
            {people.map((member) => (
              <li key={member.id} className="person">
                <Avatar name={member.displayName} id={member.id} />
                <span className="person-name">{member.displayName}</span>
                <span className="person-amount">{amounts[member.id] !== undefined ? money(amounts[member.id]!, currency) : '—'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="list-empty">{pending ? 'Working it out…' : state.items.length === 0 ? 'Add the items to see what each person pays.' : 'Shown once the figures above add up.'}</p>
        )}
      </section>

      {open !== null && (open === 'new' || openItem !== undefined) ? (
        <ItemSheet
          key={String(open)}
          {...(openItem !== undefined ? { item: openItem } : {})}
          people={people}
          currency={currency}
          client={props.client}
          payerId={state.payerId}
          onCancel={() => setOpen(null)}
          onDone={(item, another) => {
            update(typeof open === 'number' ? replaceItem(state.items, open, item) : addItem(state.items, item));
            if (!another) setOpen(null);
          }}
          {...(typeof open === 'number'
            ? {
                onRemove: () => {
                  update(removeItem(state.items, open));
                  setOpen(null);
                },
              }
            : {})}
        />
      ) : null}
    </fieldset>
  );
}

/** Tax, tip, service charge and discount of a receipt. Shown under More options. */
export function ItemFigures(props: SplitBodyProps) {
  const { state, update, currency, disabled } = props;
  const problems = props.problems;
  const mismatch = problems.find((p) => p.code === 'total_mismatch' && typeof p.difference === 'number');
  const at = (field: ExpenseProblem['field']): ExpenseProblem[] => problems.filter((p) => p.field === field && p !== mismatch);
  return (
    <fieldset className="figures" disabled={disabled}>
      <legend className="sub-head">Tax, tip and discount</legend>
      <div className="figure-list">
        <div className="figure">
          <label htmlFor="figure-tax">Tax</label>
          <MoneyInput id="figure-tax" value={state.tax} currency={currency} invalid={at('tax').length > 0} onChange={(tax) => update({ tax })} />
        </div>
        <label className="figure-check">
          <input type="checkbox" className="tick tick-square" checked={state.taxIncluded} onChange={(event) => update({ taxIncluded: event.target.checked })} />
          <span>Tax is already in the prices</span>
        </label>
        <Problems problems={at('tax')} />
        {FIGURES.map(({ field, label }) => (
          <div key={field} className="figure-block">
            <div className="figure">
              <label htmlFor={`figure-${field}`}>{label}</label>
              <MoneyInput id={`figure-${field}`} value={state[field]} currency={currency} invalid={at(field).length > 0} onChange={(value) => update({ [field]: value })} />
            </div>
            <Problems problems={at(field)} />
          </div>
        ))}
      </div>
    </fieldset>
  );
}
