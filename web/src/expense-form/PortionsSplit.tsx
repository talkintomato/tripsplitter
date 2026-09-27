import { Minus, Plus } from '../components/icons';
import { Avatar } from '../components/ui';
import { money } from '../format';
import type { SplitBodyProps } from './registry';

/** A whole number per person: someone with 2 pays twice what someone with 1 pays. */
export function PortionsSplit({ state, update, members, amounts, currency, disabled, meId }: SplitBodyProps) {
  const set = (id: number, value: number): void => {
    const portions = { ...state.portions, [id]: Math.max(0, Math.min(99, Math.trunc(value) || 0)) };
    update({ portions });
  };
  const counted = members.filter((m) => (state.portions[m.id] ?? 0) > 0);
  const total = counted.reduce((sum, m) => sum + (state.portions[m.id] ?? 0), 0);

  return (
    <fieldset className="people-card" disabled={disabled}>
      <legend className="visually-hidden">Portions for each person</legend>
      {members.map((member) => {
        const value = state.portions[member.id] ?? 0;
        const amount = amounts?.[member.id];
        return (
          <div key={member.id} className={`person ${value > 0 ? '' : 'person-out'}`}>
            <Avatar name={member.displayName} />
            <span className="person-name-block">
              <span className="person-name" id={`portion-name-${member.id}`}>
                {member.displayName}
              </span>
              <span className="person-amount">{value > 0 ? (amount !== undefined ? money(amount, currency) : '…') : member.id === meId ? 'You are left out' : 'Left out'}</span>
            </span>
            <span className="stepper">
              <button type="button" aria-label={`Fewer portions for ${member.displayName}`} disabled={value <= 0} onClick={() => set(member.id, value - 1)}>
                <Minus size={16} />
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
                <Plus size={16} />
              </button>
            </span>
          </div>
        );
      })}
      <div className="people-foot">
        <span>
          {total} {total === 1 ? 'portion' : 'portions'} between {counted.length} {counted.length === 1 ? 'person' : 'people'}. Someone with 2 pays twice as much as someone with 1; 0 leaves a person out.
        </span>
      </div>
    </fieldset>
  );
}
