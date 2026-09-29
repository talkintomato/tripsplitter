import { useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { canOpenLocationSettings, currentLocation, openLocationSettings } from '../telegram';
import { locationText, taggedLocation, type ExpenseLocation } from '../location';

export function LocationField({ client, location, onChange, disabled, onBusy }: {
  client: ApiClient; location: ExpenseLocation | null; onChange(location: ExpenseLocation | null): void; disabled: boolean; onBusy(busy: boolean): void;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [unavailable, setUnavailable] = useState(false);
  async function useCurrent() {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setUnavailable(false);
    try {
      const coords = await currentLocation();
      if (!coords) { setUnavailable(true); return; }
      const next = taggedLocation(coords.lat, coords.lng, 'device');
      try { next.placeName = (await client.lookupPlace(next.locationLat!, next.locationLng!)).name; } catch { /* Coordinates still work. */ }
      onChange(next);
    } finally { lock.current = false; setBusy(false); onBusy(false); }
  }
  return <section className="field location-field" aria-label="Location">
    <span className="field-label">Location</span>
    {location ? <div className="location-row"><span>{locationText(location)}</span><button type="button" className="link-btn" disabled={disabled || busy} onClick={() => onChange(null)} aria-label="Remove location">Remove</button></div>
      : <button type="button" className="link-btn" disabled={disabled || busy} onClick={() => void useCurrent()}>{busy ? 'Getting location…' : 'Use my current location'}</button>}
    {unavailable ? <div role="status"><p className="field-hint">Location isn't available. Allow location for Telegram in your phone's settings.</p>
      {canOpenLocationSettings() ? <button type="button" className="link-btn" onClick={openLocationSettings}>Open location settings</button> : null}</div> : null}
  </section>;
}
