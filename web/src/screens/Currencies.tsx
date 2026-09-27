import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ratesApi } from '../api/rates';
import type { Trip } from '../api/types';
import { ActionError, Banner, Confirm, ErrorState, Loading, Screen, Section } from '../components/ui';
import { useApp } from '../state';
import { useLoad } from '../useLoad';
import { CurrencyField } from './RateFields';

export function Currencies() {
  const { client, refresh } = useApp();
  const tripId = Number(useParams().tripId);
  const loaded = useLoad(() => ratesApi(client).list(tripId), `currencies-${tripId}`);
  const [currency, setCurrency] = useState('JPY');
  return <Screen title="Trip settings" back="/">
    {loaded.error !== undefined ? <ErrorState error={loaded.error} onRetry={() => void loaded.reload()} /> : !loaded.data ? <Loading /> : <>
      <TripSettings key={`${loaded.data.trip.id}-${loaded.data.trip.homeCurrency}-${loaded.data.trip.name}`} trip={loaded.data.trip} onSaved={async () => { await refresh(); await loaded.reload(); }} />
      <Section title="Currencies">
        <p className="hint small">Rates stay fixed until someone changes them.</p>
        {loaded.data.rates.length === 0 ? <p>No foreign currencies added yet.</p> : <ul className="list">{loaded.data.rates.map((r) => <li className="card" key={r.currency}>
          <strong>1 {loaded.data!.trip.homeCurrency} = {r.rate} {r.currency}</strong>
          <span className="hint small">{r.origin === 'member' ? 'Set by a member' : 'Suggested rate'}</span>
          {loaded.data!.trip.status === 'active' ? <Link to={`/trips/${tripId}/rates/${r.currency}`}>Change rate</Link> : null}
        </li>)}</ul>}
        {loaded.data.trip.status === 'active' ? <>
          <CurrencyField label="Add currency" value={currency === loaded.data.trip.homeCurrency ? (currency === 'JPY' ? 'SGD' : 'JPY') : currency} exclude={loaded.data.trip.homeCurrency} onChange={setCurrency} />
          <Link className="button button-quiet" to={`/trips/${tripId}/rates/${currency === loaded.data.trip.homeCurrency ? (currency === 'JPY' ? 'SGD' : 'JPY') : currency}`}>Set rate</Link>
        </> : null}
      </Section>
    </>}
  </Screen>;
}

function TripSettings({ trip, onSaved }: { trip: Trip; onSaved(): Promise<void> }) {
  const { client } = useApp();
  const [name, setName] = useState(trip.name);
  const [home, setHome] = useState<string>(trip.homeCurrency);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);
  async function save(body: { name?: string; homeCurrency?: string }) {
    setBusy(true); setError(undefined); setDone(false);
    try { await client.patchTrip(trip.id, body); await onSaved(); setDone(true); }
    catch (e) { setError(e); }
    finally { setBusy(false); setConfirm(false); }
  }
  const ended = trip.status === 'ended';
  return <>
    <ActionError error={error} />{done ? <Banner>Trip settings saved.</Banner> : null}
    <Section title="Trip name">
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save({ name: name.trim() }); }}>
        <label className="field"><span>Name</span><input value={name} maxLength={100} disabled={busy || ended} onChange={(e) => setName(e.target.value)} /></label>
        {!ended ? <button className="button button-quiet" disabled={busy || !name.trim() || name.trim() === trip.name}>Save name</button> : null}
      </form>
    </Section>
    <Section title="Home currency">
      <p>Balances and payments are in {trip.homeCurrency}.</p>
      {trip.homeCurrencyLocked ? <p className="hint small">The home currency is locked because an expense or payment has been confirmed.</p> : !ended ? <>
        <CurrencyField label="Home currency" value={home} onChange={setHome} disabled={busy} />
        <button className="button button-quiet" disabled={busy || home === trip.homeCurrency} onClick={() => setConfirm(true)}>Change home currency</button>
      </> : null}
    </Section>
    {confirm ? <Confirm title={`Change home currency to ${home}?`} confirmLabel="Change home currency" busy={busy} onCancel={() => { if (!busy) setConfirm(false); }} onConfirm={() => void save({ homeCurrency: home })}>
      <p>All trip rates and rates entered for individual expenses will be cleared. Foreign expenses will need new rates.</p>
    </Confirm> : null}
  </>;
}
