import { Avatar } from '../components/ui';
import { amountText, money } from '../format';
import type { SplitBodyProps } from './registry';

/** "3.34 SGD per person (3 people)", from the amounts the server gave. Nothing is worked out here. */
function perPerson(amounts: number[], currency: string): string {
  const people = `${amounts.length} ${amounts.length === 1 ? 'person' : 'people'}`;
  if (amounts.length === 0) return 'Nobody is included yet';
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  const each = low === high ? money(low, currency) : `${amountText(low, currency)}–${money(high, currency)}`;
  return `${each} per person (${people})`;
}

/** Tick boxes: everyone ticked pays the same. */
export function EvenSplit({ state, update, members, amounts, currency, disabled, meId }: SplitBodyProps) {
  const included = new Set(state.included);
  const toggle = (id: number): void => {
    const next = included.has(id) ? state.included.filter((m) => m !== id) : [...state.included, id];
    update({ included: next });
  };
  const everyone = members.every((m) => included.has(m.id));
  const ticked = members.filter((m) => included.has(m.id));
  const shown = amounts === null ? null : ticked.map((m) => amounts[m.id]).filter((a): a is number => a !== undefined);
  const foot = shown !== null && shown.length === ticked.length ? perPerson(shown, currency) : ticked.length === 0 ? 'Nobody is included yet' : `Split equally between ${ticked.length} ${ticked.length === 1 ? 'person' : 'people'}`;

  return (
    <fieldset className="people-card" disabled={disabled}>
      <legend className="visually-hidden">Who is included</legend>
      {members.map((member) => {
        const on = included.has(member.id);
        return (
          <label key={member.id} className={`person ${on ? '' : 'person-out'}`}>
            <input type="checkbox" className="tick" checked={on} onChange={() => toggle(member.id)} />
            <Avatar name={member.displayName} />
            <span className="person-name">{member.displayName}</span>
            {member.id === meId ? <span className="you-tag">you</span> : null}
            <span className="person-amount">{on && amounts?.[member.id] !== undefined ? money(amounts[member.id]!, currency) : ''}</span>
          </label>
        );
      })}
      <div className="people-foot">
        <span>{foot}</span>
        <button type="button" className="link-btn small" onClick={() => update({ included: everyone ? [] : members.map((m) => m.id) })}>
          {everyone ? 'Clear all' : 'Select all'}
        </button>
      </div>
    </fieldset>
  );
}
