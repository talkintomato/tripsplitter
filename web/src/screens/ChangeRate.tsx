import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { isValidRate } from '../../../src/core/rates';
import { isSupportedCurrency } from '../../../src/core/currencies';
import { ratesApi } from '../api/rates';
import { useTripRateChange } from '../api/useTripRateChange';
import type { Trip } from '../api/types';
import { ActionError, Banner, ErrorState, Loading, Screen } from '../components/ui';
import { useApp } from '../state';
import { useLoad } from '../useLoad';
import { RateComparison, RateField } from './RateFields';

export function ChangeRate() {
  const { client } = useApp();
  const params = useParams();
  const tripId = Number(params.tripId);
  const currency = params.currency ?? '';
  const loaded = useLoad(async () => {
    const data = await ratesApi(client).list(tripId);
    return { ...data, value: data.rates.find((r) => r.currency === currency)?.rate ?? '' };
  }, `rate-${tripId}-${currency}`);
  return <Screen title={loaded.data?.value === '' ? 'Add currency' : 'Change rate'} back={`/trips/${tripId}/currencies`}>
    {loaded.error !== undefined ? <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} /> : !loaded.data ? <Loading /> :
      !isSupportedCurrency(currency) || currency === loaded.data.trip.homeCurrency ? <p className="list-empty">Choose a foreign currency from trip settings.</p> :
      <RateEditor key={`${tripId}-${currency}`} trip={loaded.data.trip} currency={currency} initial={loaded.data.value} />}
  </Screen>;
}

function RateEditor({ trip, currency, initial }: { trip: Trip; currency: string; initial: string }) {
  const { client, group } = useApp();
  const navigate = useNavigate();
  const [rate, setRate] = useState(initial);
  const change = useTripRateChange(client, trip.id, currency);
  const { preview, busy } = change;
  if (trip.status === 'ended') return <p className="list-empty">This trip has ended. Its rates cannot be changed.</p>;
  return <>
    <ActionError error={change.error} />
    {change.note ? <Banner kind="warn">{change.note}</Banner> : null}
    <div className="card card-pad">
      <RateField home={trip.homeCurrency} currency={currency} value={rate} disabled={busy} onChange={(value) => { setRate(value); change.reset(); }} />
      {!isValidRate(rate) && rate !== '' ? <p className="problem">Enter a number above zero with up to 6 decimal places.</p> : null}
      <button className="btn btn-ghost" disabled={busy} onClick={() => void change.suggest(trip.homeCurrency, setRate)}>Suggest a rate</button>
    </div>
    <p className="field-hint">This rate applies to past and future expenses in {currency}, unless an expense has its own rate.</p>
    {preview ? <div className="card card-pad"><RateComparison preview={preview} home={trip.homeCurrency} members={group.members} /></div> : null}
    <div className="action-bar">
      {preview ? <button className="btn btn-primary btn-block btn-lg" disabled={busy} onClick={() => void change.apply(rate, () => navigate(`/trips/${trip.id}/currencies`, { replace: true }))}>Confirm rate</button>
      : <button className="btn btn-primary btn-block btn-lg" disabled={busy || !isValidRate(rate)} onClick={() => void change.previewRate(rate)}>{busy ? 'Working…' : 'Preview change'}</button>}
    </div>
  </>;
}
