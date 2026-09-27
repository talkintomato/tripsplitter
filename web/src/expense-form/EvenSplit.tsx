import { money } from '../format';
import type { SplitBodyProps } from './registry';

/** Tick boxes: everyone ticked pays the same. */
export function EvenSplit({ state, update, members, amounts, currency, disabled }: SplitBodyProps) {
  const included = new Set(state.included);
  const toggle = (id: number): void => {
    const next = included.has(id) ? state.included.filter((m) => m !== id) : [...state.included, id];
    update({ included: next });
  };
  const everyone = members.every((m) => included.has(m.id));

  return (
    <fieldset className="people" disabled={disabled}>
      <legend>
        <span>Who is included</span>
        <button type="button" className="link" onClick={() => update({ included: everyone ? [] : members.map((m) => m.id) })}>
          {everyone ? 'Clear all' : 'Select all'}
        </button>
      </legend>
      {members.map((member) => (
        <label key={member.id} className="person">
          <input type="checkbox" checked={included.has(member.id)} onChange={() => toggle(member.id)} />
          <span className="person-name">{member.displayName}</span>
          <span className="person-amount">{included.has(member.id) && amounts?.[member.id] !== undefined ? money(amounts[member.id]!, currency) : ''}</span>
        </label>
      ))}
    </fieldset>
  );
}
