import type { ExpenseLocation } from '../../src/db/types';
export type { ExpenseLocation };
export const noLocation: ExpenseLocation = { locationLat: null, locationLng: null, placeName: null, locationSource: null };
export function locationText(location: Partial<ExpenseLocation> | null | undefined): string {
  if (location?.locationLat == null || location.locationLng == null) return 'none';
  return location.placeName || `Near ${location.locationLat.toFixed(5)}, ${location.locationLng.toFixed(5)}`;
}
export function taggedLocation(lat: number, lng: number, source: 'photo' | 'device'): ExpenseLocation {
  return { locationLat: Number(lat.toFixed(5)), locationLng: Number(lng.toFixed(5)), placeName: null, locationSource: source };
}
