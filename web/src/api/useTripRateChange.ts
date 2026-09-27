import { useState } from 'react';
import { ApiError, type ApiClient } from './client';
import { ratesApi, type RatePreview } from './rates';

export type TripRateApplied = Awaited<ReturnType<ReturnType<typeof ratesApi>['apply']>>;

/**
 * Changing a trip's rate for one currency: preview what changes, then apply that preview. Used by the Change rate
 * screen and by the exchange rate sheet of the expense form, so both behave the same.
 * When someone else changed the trip in between, the new preview is shown and has to be confirmed again.
 */
export function useTripRateChange(client: ApiClient, tripId: number, currency: string) {
  const api = ratesApi(client);
  const [preview, setPreview] = useState<RatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [note, setNote] = useState('');

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNote('');
    try {
      await work();
    } catch (problem) {
      if (problem instanceof ApiError && problem.stale) {
        setPreview(problem.current as RatePreview);
        setNote('The trip changed. Check the updated preview below before confirming again.');
      } else {
        setError(problem);
        setPreview(null);
      }
    } finally {
      setBusy(false);
    }
  }

  return {
    preview,
    busy,
    error,
    note,
    setNote,
    /** Forgets the preview, after the rate was changed. */
    reset(): void {
      setPreview(null);
      setNote('');
    },
    /** The latest rate, or null with a note when there is none. */
    suggest(home: string, onRate: (rate: string) => void): Promise<void> {
      return run(async () => {
        const result = await api.suggest(tripId, currency);
        setPreview(null);
        if (result.rate !== null && result.homeCurrency === home) onRate(result.rate);
        else setNote('No suggestion is available. Enter a rate to continue.');
      });
    },
    previewRate(rate: string): Promise<void> {
      return run(async () => {
        setPreview(await api.preview(tripId, currency, rate));
      });
    },
    /** Applies the rate as previewed. `after` runs only when it was applied. */
    apply(rate: string, after: (result: TripRateApplied) => void): Promise<void> {
      return run(async () => {
        if (!preview) return;
        const result = await api.apply(tripId, currency, rate, preview.snapshot);
        after(result);
      });
    },
  };
}
