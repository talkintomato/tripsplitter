import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { isValidRate } from '../../../src/core/rates';
import { isSupportedCurrency } from '../../../src/core/currencies';
import { ApiError } from '../api/client';
import { ratesApi, type RatePreview } from '../api/rates';
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
      !isSupportedCurrency(currency) || currency === loaded.data.trip.homeCurrency ? <p>Choose a foreign currency from trip settings.</p> :
      <RateEditor key={`${tripId}-${currency}`} trip={loaded.data.trip} currency={currency} initial={loaded.data.value} />}
  </Screen>;
}

function RateEditor({ trip, currency, initial }: { trip: Trip; currency: string; initial: string }) {
  const { client } = useApp();
  const api = ratesApi(client);
  const navigate = useNavigate();
  const [rate, setRate] = useState(initial);
  const [preview, setPreview] = useState<RatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState('');
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(undefined); setNote('');
    try { await work(); } catch (e) {
      if (e instanceof ApiError && e.stale) {
        setPreview(e.current as RatePreview);
        setNote('The trip changed. Check the updated preview below before confirming again.');
      } else { setError(e); setPreview(null); }
    } finally { setBusy(false); }
  }
  if (trip.status === 'ended') return <p>This trip has ended. Its rates cannot be changed.</p>;
  return <>
    <ActionError error={error} />
    {note ? <Banner>{note}</Banner> : null}
    <RateField home={trip.homeCurrency} currency={currency} value={rate} disabled={busy} onChange={(value) => { setRate(value); setPreview(null); setNote(''); }} />
    <button className="button button-quiet" disabled={busy} onClick={() => void run(async () => {
      const result = await api.suggest(trip.id, currency);
      setPreview(null);
      if (result.rate !== null && result.homeCurrency === trip.homeCurrency) setRate(result.rate);
      else setNote('No suggestion is available. Enter a rate to continue.');
    })}>Suggest a rate</button>
    {!isValidRate(rate) && rate !== '' ? <p className="problem">Enter a number above zero with up to 6 decimal places.</p> : null}
    <p className="hint small">This rate applies to past and future expenses in {currency}, unless an expense has its own rate.</p>
    <button className="button" disabled={busy || !isValidRate(rate)} onClick={() => void run(async () => { setPreview(await api.preview(trip.id, currency, rate)); })}>{busy ? 'Working…' : 'Preview change'}</button>
    {preview ? <><RateComparison preview={preview} home={trip.homeCurrency} />
      <button className="button" disabled={busy} onClick={() => void run(async () => {
        await api.apply(trip.id, currency, rate, preview.snapshot);
        navigate(`/trips/${trip.id}/currencies`, { replace: true });
      })}>Confirm rate</button></> : null}
  </>;
}
