import { describe, expect, it } from 'vitest';
import { buildConfig } from '../../src/config.js';
import { LAUNCH_MAX_LENGTH, LaunchError, decodeLaunch, encodeLaunch, launchUrl, type Launch } from '../../src/core/index.js';

const SECRET = 'a-secret-of-at-least-thirty-two-characters';

describe('launch parameter', () => {
  const launches: Launch[] = [
    { groupId: 1, linkVersion: 1, view: 'home' },
    { groupId: 42, linkVersion: 1, view: 'add' },
    { groupId: 42, linkVersion: 3, view: 'balances' },
    { groupId: 42, linkVersion: 12, view: 'expense', expenseId: 1234 },
    { groupId: Number.MAX_SAFE_INTEGER, linkVersion: Number.MAX_SAFE_INTEGER, view: 'expense', expenseId: Number.MAX_SAFE_INTEGER },
  ];

  it('round trip', () => {
    for (const launch of launches) expect(decodeLaunch(encodeLaunch(launch, SECRET), SECRET)).toEqual(launch);
  });

  it('has the documented format', () => {
    expect(encodeLaunch({ groupId: 42, linkVersion: 3, view: 'expense', expenseId: 7 }, SECRET)).toMatch(/^v1_42_3_expense_7_[A-Za-z0-9_-]{22}$/);
    expect(encodeLaunch({ groupId: 42, linkVersion: 1, view: 'home' }, SECRET)).toMatch(/^v1_42_1_home_0_[A-Za-z0-9_-]{22}$/);
  });

  it('stays within the characters and length Telegram allows', () => {
    for (const launch of launches) {
      for (const secret of [SECRET, 'another-secret-that-is-long-enough-123', 'x'.repeat(64)]) {
        const param = encodeLaunch(launch, secret);
        expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(param.length).toBeLessThanOrEqual(LAUNCH_MAX_LENGTH);
      }
    }
  });

  it('refuses a tampered parameter', () => {
    const param = encodeLaunch({ groupId: 42, linkVersion: 3, view: 'expense', expenseId: 7 }, SECRET);
    const tampered = [
      param.replace('v1_42_', 'v1_43_'),
      param.replace('v1_42_3_', 'v1_42_4_'),
      param.replace('_expense_7_', '_expense_8_'),
      param.replace('_expense_7_', '_home_0_'),
      `${param.slice(0, -1)}${param.endsWith('A') ? 'B' : 'A'}`,
    ];
    for (const bad of tampered) {
      expect(() => decodeLaunch(bad, SECRET), bad).toThrow(LaunchError);
      try {
        decodeLaunch(bad, SECRET);
      } catch (error) {
        expect((error as LaunchError).reason).toBe('signature');
      }
    }
    expect(() => decodeLaunch(param, 'a-different-secret-of-thirty-two-chars!')).toThrow(LaunchError);
  });

  it('refuses a parameter with the wrong form', () => {
    const good = encodeLaunch({ groupId: 42, linkVersion: 1, view: 'home' }, SECRET);
    const signature = good.slice(-22);
    const wrong = ['', 'hello', `v2_42_1_home_0_${signature}`, `v1_42_home_0_${signature}`, `v1_0_1_home_0_${signature}`, `v1_42_0_home_0_${signature}`];
    for (const bad of [...wrong, good.slice(0, -3), `${good}x`, `${good} `, 'x'.repeat(600)]) {
      try {
        decodeLaunch(bad, SECRET);
        expect.unreachable(bad);
      } catch (error) {
        expect(error).toBeInstanceOf(LaunchError);
        expect((error as LaunchError).reason).toBe('format');
      }
    }
    expect(() => decodeLaunch(undefined as unknown as string, SECRET)).toThrow(LaunchError);
  });

  it('refuses a launch that makes no sense', () => {
    expect(() => encodeLaunch({ groupId: 42, linkVersion: 1, view: 'expense' }, SECRET)).toThrow(RangeError);
    expect(() => encodeLaunch({ groupId: 42, linkVersion: 1, view: 'home', expenseId: 7 }, SECRET)).toThrow(RangeError);
    expect(() => encodeLaunch({ groupId: 0, linkVersion: 1, view: 'home' }, SECRET)).toThrow(RangeError);
    expect(() => encodeLaunch({ groupId: 1.5, linkVersion: 1, view: 'home' }, SECRET)).toThrow(RangeError);
    expect(() => encodeLaunch({ groupId: 1, linkVersion: 0, view: 'home' }, SECRET)).toThrow(RangeError);
    expect(() => encodeLaunch({ groupId: 1, view: 'home' } as never, SECRET)).toThrow(RangeError);
    expect(() => encodeLaunch({ groupId: 1, linkVersion: 1, view: 'settings' as never }, SECRET)).toThrow(RangeError);
    expect(() => encodeLaunch({ groupId: 1, linkVersion: 1, view: 'home' }, '')).toThrow(RangeError);
  });

  it('builds the link', () => {
    const config = buildConfig({ botUsername: 'trip_bot', miniAppName: 'split', linkSecret: SECRET });
    const url = launchUrl(config, { groupId: 42, linkVersion: 2, view: 'balances' });
    expect(url).toBe(`https://t.me/trip_bot/split?startapp=${encodeLaunch({ groupId: 42, linkVersion: 2, view: 'balances' }, SECRET)}`);
    expect(decodeLaunch(new URL(url).searchParams.get('startapp')!, SECRET)).toEqual({ groupId: 42, linkVersion: 2, view: 'balances' });
  });
});
