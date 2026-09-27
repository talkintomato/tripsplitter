import { useState, type ReactNode } from 'react';
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
export function TripSetup(props: { tripId?: number; automatic?: boolean; leading?: ReactNode }) {
  const params = useParams();
  const tripId = props.tripId ?? Number(params.tripId);
  const { client } = useApp();
  const loaded = useLoad(() => ratesApi(client).list(tripId), `setup-${tripId}`);
  return <Screen title="Set up your trip" back={false} leading={props.leading} subtitle="Choose the currencies you will use">
    {loaded.error !== undefined ? <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} /> : !loaded.data ? <Loading /> :
      <SetupForm key={tripId} trip={loaded.data.trip} existing={Object.fromEntries(loaded.data.rates.map((r) => [r.currency, r.rate]))} automatic={props.automatic ?? false} />}
  </Screen>;
}

function SetupForm({ trip: initial, existing, automatic }: { trip: Trip; existing: Record<string, string>; automatic: boolean }) {
  const { client, refresh, group } = useApp();
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
  if (trip.status === 'ended') return <p className="list-empty">This trip has ended.</p>;
  return <>
    <ActionError error={error instanceof ApiError && error.stale ? undefined : error} />
    {error instanceof ApiError && error.stale ? <Banner kind="warn">The trip changed. Review currencies again before saving.</Banner> : null}
    {error !== undefined && stage === 'rates' ? <p className="field-hint">Some rates may already be saved. Review currencies again to continue.</p> : null}
    {note ? <Banner>{note}</Banner> : null}
    <ol className="steps" aria-label="Steps">
      <li className={stage === 'home' ? 'on' : 'done'}>1. Home currency</li>
      <li className={stage === 'rates' ? 'on' : ''}>2. Other currencies</li>
    </ol>
    {stage === 'home' ? <div className="card card-pad">
      <CurrencyField label="Home currency" value={home} onChange={setHome} disabled={busy || trip.homeCurrencyLocked} />
      <p className="field-hint">Balances and payments use this currency. {trip.homeCurrencyLocked ? 'It is locked because an expense or payment has been confirmed.' : 'It locks after the first confirmed expense or payment.'}</p>
      <button className="btn btn-primary btn-block btn-lg" disabled={busy} onClick={() => {
        if (home !== trip.homeCurrency) setConfirm(true);
        else void run(chooseHome);
      }}>Continue</button>
    </div> : <>
      <div className="card summary-line">
        <span className="muted-2">Home currency</span>
        <strong>{trip.homeCurrency}</strong>
      </div>
      <fieldset className="section" disabled={busy}>
        <legend className="section-head"><span className="section-label">Which other currencies will you use?</span></legend>
        <ul className="list-card choice-list">
          {CURRENCIES.filter((c) => c.code !== trip.homeCurrency).map((c) => <li key={c.code}>
            <label className="item"><input type="checkbox" className="tick tick-square" checked={rates[c.code] !== undefined} onChange={(e) => {
              setPreviews(null);
              if (!e.target.checked) { setRates((current) => { const next = { ...current }; delete next[c.code]; return next; }); return; }
              setRates((current) => ({ ...current, [c.code]: '' }));
              void run(async () => {
                const result = await api.suggest(trip.id, c.code);
                if (result.rate !== null && result.homeCurrency === trip.homeCurrency) setRates((current) => ({ ...current, [c.code]: result.rate! }));
                else setNote(`No suggestion for ${c.code}. Enter a rate, or leave this currency unticked for now.`);
              });
            }} /><span className="row-main"><span className="row-title">{c.code}</span><span className="row-sub">{c.name}</span></span></label>
            {rates[c.code] !== undefined ? <div className="rate-under"><RateField home={trip.homeCurrency} currency={c.code} value={rates[c.code]!} onChange={(value) => { setPreviews(null); setRates((current) => ({ ...current, [c.code]: value })); }} disabled={busy} /></div> : null}
          </li>)}
        </ul>
      </fieldset>
      <p className="field-hint">Saving records these as rates set by you. Rates already saved stay on the trip even if unticked here.</p>
      {previews ? Object.entries(previews).map(([currency, preview]) => <section className="card card-pad" key={currency}>
        <p className="sub-head">1 {trip.homeCurrency} = {rates[currency]} {currency}</p>
        <RateComparison preview={preview} home={trip.homeCurrency} members={group.members} />
      </section>) : null}
      <button className="btn btn-primary btn-block btn-lg" disabled={busy || Object.values(rates).some((rate) => !isValidRate(rate))} onClick={() => void run(async () => {
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
    <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => void run(finish)}>Skip for now</button>
    <p className="field-hint center">You can manage currencies and rename the trip later, from the trip's menu.</p>
    {confirm ? <Confirm title={`Use ${home} as home currency?`} confirmLabel="Use this currency" busy={busy} onCancel={() => { if (!busy) setConfirm(false); }} onConfirm={() => void run(chooseHome)}>
      <p>All trip rates and rates entered for individual expenses will be cleared. Foreign expenses will need new rates.</p>
    </Confirm> : null}
  </>;
}
