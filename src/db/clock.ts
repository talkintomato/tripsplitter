let clock: () => Date = () => new Date();

/** The current time as the operations see it. */
export function now(): Date {
  return clock();
}

/** The current time as ISO 8601 text in UTC, the format of every timestamp column. */
export function nowIso(): string {
  return clock().toISOString();
}

/** Tests only: replace the clock that stamps records. Pass null to go back to the real one. */
export function setClockForTests(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date());
}

/** The Singapore date (UTC+8, no daylight saving) of a moment, as YYYY-MM-DD. Day boundaries for daily limits use it. */
export function singaporeDate(moment: Date = now()): string {
  return new Date(moment.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
