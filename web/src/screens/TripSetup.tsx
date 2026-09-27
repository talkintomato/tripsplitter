import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CURRENCIES } from '../../../src/core/currencies';
import { isValidRate } from '../../../src/core/rates';
import { ApiError } from '../api/client';
import { ratesApi, type RatePreview } from '../api/rates';
import type { Trip } from '../api/types';
import { ActionError, Banner, Confirm, ErrorState, Loading, Screen } from '../components/ui';
import { useApp } from '../state';
import { useLoad } from '../useLoad';
import { CurrencyField, RateComparison, RateField } from './RateFields';

/** Also used as an entry gate: finishing returns to the destination in the group's link. */
export function TripSetup(props: { tripId?: number; automatic?: boolean }) {
  const params = useParams();
  const tripId = props.tripId ?? Number(params.tripId);
  const { client } = useApp();
  const loaded = useLoad(() => ratesApi(client).list(tripId), `setup-${tripId}`);
  return <Screen title="Set up your trip" back={false} subtitle="Choose the currencies you will use. You can add more later.">
    {loaded.error !== undefined ? <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} /> : !loaded.data ? <Loading /> :
      <SetupForm key={tripId} trip={loaded.data.trip} existing={Object.fromEntries(loaded.data.rates.map((r) => [r.currency, r.rate]))} automatic={props.automatic ?? false} />}
  </Screen>;
}

function SetupForm({ trip: initial, existing, automatic }: { trip: Trip; existing: Record<string, string>; automatic: boolean }) {
  const { client, refresh } = useApp();
  const navigate = useNavigate();
  const api = ratesApi(client);
  const [trip, setTrip] = useState(initial);
  const [home, setHome] = useState<string>(initial.homeCurrency);
  const [stage, setStage] = useState<'home' | 'rates'>('home');
  const [rates, setRates] = useState<Record<string, string>>(existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [previews, setPreviews] = useState<Record<string, RatePreview> | null>(null);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(undefined); setNote('');
    try { await work(); } catch (e) { setPreviews(null); setError(e); }
    finally { setBusy(false); setConfirm(false); }
  }
  async function finish() {
    await client.patchTrip(trip.id, { setupDone: true });
    await refresh();
    if (!automatic) navigate('/', { replace: true });
  }
  async function chooseHome() {
    if (home !== trip.homeCurrency) {
      const result = await client.patchTrip(trip.id, { homeCurrency: home });
      setTrip(result.trip); setRates({});
    }
    setStage('rates');
  }
  if (trip.status === 'ended') return <p>This trip has ended.</p>;
  return <>
    <ActionError error={error instanceof ApiError && error.stale ? undefined : error} />{error instanceof ApiError && error.stale ? <Banner>The trip changed. Review currencies again before saving.</Banner> : null}{error !== undefined && stage === 'rates' ? <p className="hint small">Some rates may already be saved. Review currencies again to continue.</p> : null}{note ? <Banner>{note}</Banner> : null}
    {stage === 'home' ? <>
      <CurrencyField label="Home currency" value={home} onChange={setHome} disabled={busy || trip.homeCurrencyLocked} />
      <p className="hint small">Balances and payments use this currency. {trip.homeCurrencyLocked ? 'It is locked because an expense or payment has been confirmed.' : 'It locks after the first confirmed expense or payment.'}</p>
      <button className="button" disabled={busy} onClick={() => {
        if (home !== trip.homeCurrency) setConfirm(true);
        else void run(chooseHome);
      }}>Continue</button>
    </> : <>
      <p>Home currency: <strong>{trip.homeCurrency}</strong></p>
      <fieldset className="people" disabled={busy}><legend><span>Which other currencies will you use?</span></legend>
        {CURRENCIES.filter((c) => c.code !== trip.homeCurrency).map((c) => <div className="section" key={c.code}>
          <label className="person"><input type="checkbox" checked={rates[c.code] !== undefined} onChange={(e) => {
            setPreviews(null);
            if (!e.target.checked) { setRates((current) => { const next = { ...current }; delete next[c.code]; return next; }); return; }
            setRates((current) => ({ ...current, [c.code]: '' }));
            void run(async () => {
              const result = await api.suggest(trip.id, c.code);
              if (result.rate !== null && result.homeCurrency === trip.homeCurrency) setRates((current) => ({ ...current, [c.code]: result.rate! }));
              else setNote(`No suggestion for ${c.code}. Enter a rate, or leave this currency unticked for now.`);
            });
          }} /><span>{c.code} — {c.name}</span></label>
          {rates[c.code] !== undefined ? <RateField home={trip.homeCurrency} currency={c.code} value={rates[c.code]!} onChange={(value) => { setPreviews(null); setRates((current) => ({ ...current, [c.code]: value })); }} disabled={busy} /> : null}
        </div>)}
      </fieldset>
      <p className="hint small">Saving records these as rates set by you. Rates already saved stay on the trip even if unticked here.</p>
      {previews ? Object.entries(previews).map(([currency, preview]) => <section className="section" key={currency}>
        <strong>1 {trip.homeCurrency} = {rates[currency]} {currency}</strong>
        <RateComparison preview={preview} home={trip.homeCurrency} />
      </section>) : null}
      <button className="button" disabled={busy || Object.values(rates).some((rate) => !isValidRate(rate))} onClick={() => void run(async () => {
        if (previews === null) {
          const next: Record<string, RatePreview> = {};
          for (const [currency, rate] of Object.entries(rates)) next[currency] = await api.preview(trip.id, currency, rate);
          setPreviews(next);
          return;
        }
        for (const [currency, rate] of Object.entries(rates)) {
          await api.apply(trip.id, currency, rate, previews[currency]!.snapshot);
        }
        await finish();
      })}>{busy ? 'Working…' : previews ? 'Confirm currencies' : 'Review currencies'}</button>
    </>}
    <button className="button button-quiet" disabled={busy} onClick={() => void run(finish)}>Skip for now</button>
    <p className="hint small">You can manage currencies and rename the trip in Trip settings.</p>
    {confirm ? <Confirm title={`Use ${home} as home currency?`} confirmLabel="Use this currency" busy={busy} onCancel={() => { if (!busy) setConfirm(false); }} onConfirm={() => void run(chooseHome)}>
      <p>All trip rates and rates entered for individual expenses will be cleared. Foreign expenses will need new rates.</p>
    </Confirm> : null}
  </>;
}
