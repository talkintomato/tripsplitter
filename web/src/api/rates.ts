import type { ApiClient } from './client';
import type { Trip } from './types';

export interface TripRate {
  currency: string;
  rate: string;
  origin: 'member' | 'suggested';
}
export interface RatePreview {
  currentRate: TripRate | null;
  expensesChanged: number;
  confirmedExpensesChanged: number;
  balancesBefore: Record<number, number>;
  balancesAfter: Record<number, number>;
  snapshot: string;
}
export function ratesApi(client: ApiClient) {
  const path = (id: number) => `/api/trips/${id}/rates`;
  return {
    list: (id: number) => client.request<{ trip: Trip; rates: TripRate[] }>('GET', path(id)),
    suggest: (id: number, currency: string) => client.request<{ homeCurrency: string; currency: string; rate: string | null }>('GET', `${path(id)}/suggest?currency=${encodeURIComponent(currency)}`),
    preview: (id: number, currency: string, rate: string) => client.request<RatePreview>('POST', `${path(id)}/${encodeURIComponent(currency)}/preview`, { rate }),
    apply: (id: number, currency: string, rate: string, snapshot: string) => client.request<{ tripRate: TripRate; expensesChanged: number; updatedExpenses: Array<{ id: number; version: number }> }>('PUT', `${path(id)}/${encodeURIComponent(currency)}`, { rate, snapshot }),
  };
}
