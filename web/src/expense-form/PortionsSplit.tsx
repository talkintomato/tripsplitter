import { money } from '../format';
import type { SplitBodyProps } from './registry';

/** A whole number per person: someone with 2 pays twice what someone with 1 pays. */
export function PortionsSplit({ state, update, members, amounts, currency, disabled }: SplitBodyProps) {
  const set = (id: number, value: number): void => {
    const portions = { ...state.portions, [id]: Math.max(0, Math.min(99, Math.trunc(value) || 0)) };
    update({ portions });
  };

  return (
    <fieldset className="people" disabled={disabled}>
      <legend>
        <span>Portions for each person</span>
      </legend>
      <p className="hint small">Someone with 2 pays twice as much as someone with 1. Use 0 to leave a person out.</p>
      {members.map((member) => {
        const value = state.portions[member.id] ?? 0;
        return (
          <div key={member.id} className="person">
            <span className="person-name" id={`portion-name-${member.id}`}>
              {member.displayName}
            </span>
            <span className="person-amount">{value > 0 && amounts?.[member.id] !== undefined ? money(amounts[member.id]!, currency) : ''}</span>
            <span className="stepper">
              <button type="button" aria-label={`Fewer portions for ${member.displayName}`} disabled={value <= 0} onClick={() => set(member.id, value - 1)}>
                −
              </button>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                aria-label={`Portions for ${member.displayName}`}
                value={String(value)}
                onFocus={(event) => event.target.select()}
                onChange={(event) => set(member.id, Number(event.target.value.replace(/\D/g, '')))}
              />
              <button type="button" aria-label={`More portions for ${member.displayName}`} onClick={() => set(member.id, value + 1)}>
                +
              </button>
            </span>
          </div>
        );
      })}
    </fieldset>
  );
}
