import type { Amount } from './types.js';

/** True for a whole number of minor units: a bigint, or a number that is a safe integer. */
export function isAmount(value: unknown): value is Amount {
  return typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value));
}

/** An amount as bigint. Throws RangeError for a number that is not a safe integer. */
export function toBigInt(value: Amount): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RangeError(`Not a whole number of minor units: ${String(value)}`);
  }
  return BigInt(value);
}

/** A bigint amount as number, for JSON. Throws RangeError when it does not fit a safe integer. */
export function toSafeNumber(value: Amount): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`Not a whole number of minor units: ${value}`);
    return value;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Amount too large');
  }
  return Number(value);
}

/** A map of amounts per member as a plain object with number values, for JSON. Keys are member IDs. */
export function amountsToRecord(amounts: ReadonlyMap<number, Amount>): Record<number, number> {
  const record: Record<number, number> = {};
  for (const [memberId, amount] of amounts) record[memberId] = toSafeNumber(amount);
  return record;
}
