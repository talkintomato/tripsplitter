import { useState } from 'react';
import { isValidRate } from '../../../src/core/rates';
import type { ApiClient } from '../api/client';
import type { Member } from '../api/types';
import { useTripRateChange, type TripRateApplied } from '../api/useTripRateChange';
import { ActionError, Banner, Sheet } from '../components/ui';
import { RateComparison } from '../screens/RateFields';

export type RateScope = 'expense' | 'trip';

export interface RateSheetProps {
  client: ApiClient;
  home: string;
  currency: string;
  members: ReadonlyArray<Member>;
  /** The rate in use now, to start from. Null when there is none. */
  current: string | null;
  /** The expense has a rate of its own. */
  ownRate: boolean;
  /** The trip whose rate "All … expenses" changes. Null while there is no trip yet. */
  tripId: number | null;
  initialScope: RateScope;
  /** "This expense only": sets the expense's own rate. Nothing is saved until the expense is. */
  onOwnRate(rate: string): void;
  /** "Use the trip rate instead": clears the expense's own rate. */
  onTripRateInstead(): void;
  /** "All … expenses": the trip's rate was changed, straight away. */
  onTripRateApplied(result: TripRateApplied, rate: string): void;
  onClose(): void;
}

const RATE_RULE = 'Enter a rate above zero, with up to 6 decimal places.';

/** Where the exchange rate of an expense is changed: for this expense only, or for the trip. */
export function RateSheet(props: RateSheetProps) {
  const { home, currency } = props;
  const [rate, setRate] = useState(props.current ?? '');
  const [scope, setScope] = useState<RateScope>(props.tripId === null ? 'expense' : props.initialScope);
  const change = useTripRateChange(props.client, props.tripId ?? 0, currency);
  const valid = isValidRate(rate);
  const reason = rate.trim() === '' ? 'Enter the rate to apply it.' : valid ? null : RATE_RULE;
  const confirming = scope === 'trip' && change.preview !== null;

  const choose = (next: RateScope): void => {
    setScope(next);
    change.reset();
  };

  const apply = (): void => {
    if (!valid) return;
    if (scope === 'expense') {
      props.onOwnRate(rate);
      props.onClose();
      return;
    }
    if (!confirming) {
      void change.previewRate(rate);
      return;
    }
    void change.apply(rate, (result) => {
      props.onTripRateApplied(result, rate);
      props.onClose();
    });
  };

  return (
    <Sheet label="Exchange rate" onClose={() => { if (!change.busy) props.onClose(); }} className="rate-sheet">
      <h2 className="sheet-title">Exchange rate</h2>
      <div className="rate-input">
        <span className="rate-input-side" aria-hidden="true">1 {home} =</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          aria-label={`How many ${currency} for 1 ${home}`}
          aria-invalid={rate !== '' && !valid}
          aria-describedby="rate-rule"
          value={rate}
          disabled={change.busy}
          onFocus={(event) => event.target.select()}
          onChange={(event) => {
            setRate(event.target.value.replace(',', '.').replace(/[^\d.]/g, ''));
            change.reset();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              apply();
            }
          }}
        />
        <span className="rate-input-side" aria-hidden="true">{currency}</span>
      </div>

      <fieldset className="rate-scope" disabled={change.busy}>
        <legend className="visually-hidden">Use this rate for</legend>
        <label className={`scope-option ${scope === 'expense' ? 'on' : ''}`}>
          <input type="radio" name="rate-scope" className="tick" checked={scope === 'expense'} onChange={() => choose('expense')} />
          <span className="row-main">
            <span className="row-title">This expense only</span>
            <span className="row-sub wrap">Other expenses keep the trip rate.</span>
          </span>
        </label>
        <label className={`scope-option ${scope === 'trip' ? 'on' : ''} ${props.tripId === null ? 'scope-off' : ''}`}>
          <input type="radio" name="rate-scope" className="tick" checked={scope === 'trip'} disabled={props.tripId === null} onChange={() => choose('trip')} />
          <span className="row-main">
            <span className="row-title">All {currency} expenses in this trip</span>
            <span className="row-sub wrap">
              {props.tripId === null ? 'Available once the trip has started.' : 'Changes the trip rate. Past expenses without their own rate update too.'}
            </span>
          </span>
        </label>
      </fieldset>

      <ActionError error={change.error} />
      {change.note ? <Banner kind="warn">{change.note}</Banner> : null}
      {confirming && change.preview ? (
        <div className="rate-confirm">
          <RateComparison preview={change.preview} home={home} members={props.members} />
        </div>
      ) : null}

      <div className="sheet-actions">
        <p className="save-reason" id="rate-rule">
          {reason ?? (scope === 'trip' ? (confirming ? 'The trip rate changes as soon as you confirm. The expense itself is saved when you tap Save.' : 'You will see what changes before the trip rate is set.') : 'Nothing is saved until you save the expense.')}
        </p>
        <button type="button" className="btn btn-primary btn-block btn-lg" disabled={!valid || change.busy} onClick={apply}>
          {change.busy ? 'Working…' : confirming ? `Confirm rate for all ${currency} expenses` : scope === 'trip' ? 'Apply' : 'Apply'}
        </button>
        {props.ownRate ? (
          <button type="button" className="btn btn-secondary btn-block" disabled={change.busy} onClick={() => { props.onTripRateInstead(); props.onClose(); }}>
            Use the trip rate instead
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-block" disabled={change.busy} onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
