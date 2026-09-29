import type { Db } from '../db/index.js';

// Shared by every API instance in this process. Refuse excess requests rather than build a queue.
let nextRequestAt = 0;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null;

export function placeName(value: unknown): string | null {
  const result = record(value);
  const address = record(result.address);
  const local = text(result.name) ?? text(address.road) ?? text(address.neighbourhood);
  const city = text(address.city) ?? text(address.town) ?? text(address.village) ?? text(address.municipality);
  return [...new Set([local, city].filter((part): part is string => part !== null))].join(', ').slice(0, 200) || null;
}

/** Only called after the member chooses to tag a location. Never log request data or failures. */
export async function lookupPlace(db: Db, enabled: boolean, lat: number, lng: number): Promise<string | null> {
  if (!enabled) return null;
  const key = [Number(lat.toFixed(3)), Number(lng.toFixed(3))];
  const now = Date.now();
  const cached = db.prepare('SELECT name, looked_up_at FROM place_cache WHERE lat = ? AND lng = ?').get(...key) as { name: string | null; looked_up_at: number } | undefined;
  if (cached && now - cached.looked_up_at < (cached.name === null ? 1 : 90) * 86400000) return cached.name;
  if (now < nextRequestAt) return null;
  nextRequestAt = now + 1000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let name: string | null = null;
  try {
    name = await Promise.race([
      (async () => {
        const query = new URLSearchParams({ format: 'jsonv2', lat: lat.toFixed(5), lon: lng.toFixed(5), zoom: '18', 'accept-language': 'en' });
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${query}`, {
          headers: { 'User-Agent': 'TripSplitter (https://github.com/talkintomato/tripsplitter)' },
          signal: controller.signal,
          redirect: 'error',
        });
        return response.ok ? placeName(await response.json()) : null;
      })(),
      new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 5000); }),
    ]);
  } catch {
    // Optional enrichment: network and parsing failures have no effect on the expense.
  } finally { clearTimeout(timer); }
  db.prepare(`INSERT INTO place_cache (lat, lng, name, looked_up_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (lat, lng) DO UPDATE SET name = excluded.name, looked_up_at = excluded.looked_up_at`).run(...key, name, Date.now());
  return name;
}
