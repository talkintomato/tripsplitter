import type { Hono } from 'hono';
import { createApi, type ApiEnv } from '../../src/api/index.js';
import { buildConfig, type Config } from '../../src/config.js';
import { encodeLaunch, type LaunchView, type Notifier } from '../../src/core/index.js';
import { getGroup, type Db } from '../../src/db/index.js';
import { initDataFor } from '../auth/helpers.js';
import { seedTwo, type Seed } from '../db/helpers.js';

export interface NoticeCall {
  name: keyof Notifier;
  notice: Record<string, unknown>;
}

export interface Reply<T = any> {
  status: number;
  body: T;
}

export interface Client {
  get<T = any>(path: string): Promise<Reply<T>>;
  post<T = any>(path: string, body?: unknown): Promise<Reply<T>>;
  put<T = any>(path: string, body?: unknown): Promise<Reply<T>>;
  patch<T = any>(path: string, body?: unknown): Promise<Reply<T>>;
}

export interface Harness {
  db: Db;
  config: Config;
  app: Hono<ApiEnv>;
  /** Group with Ana (Telegram 101), Sam (102) and hand-added Leo. */
  a: Seed;
  /** Another group in the same database: Ana (201), Sam (202), Leo. */
  b: Seed;
  notices: NoticeCall[];
  /** Names of the notices sent, in order. */
  sent(): string[];
  /** Forget the notices so far. */
  clear(): void;
  /** Make every notice fail from now on. */
  failNotices(): void;
  /** Rates the fake lookup knows, by currency. Empty: every lookup finds nothing. */
  rates: Record<string, string>;
  rateLookups: Array<[string, string]>;
  /** A start parameter for a group, signed with its current link version. */
  launch(seed: Seed, view?: LaunchView, expenseId?: number): string;
  /** A client signed in as a Telegram user, holding a start parameter. */
  as(telegramUserId: number, firstName: string, launch: string): Client;
  /** Ana of group a with a fresh link. */
  ana: Client;
  /** Sam of group a with a fresh link. */
  sam: Client;
}

const NOTICE_NAMES: Array<keyof Notifier> = [
  'expenseSaved',
  'expenseEdited',
  'expenseDeleted',
  'expenseRestored',
  'settlementRecorded',
  'settlementUndone',
  'settlementRestored',
  'tripRateChanged',
  'tripEnded',
  'tripReopened',
  'linkReset',
  'memberJoinedByLink',
];

export function harness(): Harness {
  const { db, a, b } = seedTwo();
  const config = buildConfig();
  const notices: NoticeCall[] = [];
  let failing = false;
  const notifier = Object.fromEntries(
    NOTICE_NAMES.map((name) => [
      name,
      async (notice: Record<string, unknown>) => {
        notices.push({ name, notice });
        if (failing) throw new Error('Telegram is down');
      },
    ]),
  ) as unknown as Notifier;
  const rates: Record<string, string> = {};
  const rateLookups: Array<[string, string]> = [];
  const app = createApi(config, db, {
    notifier,
    suggestRate: async (from, to) => {
      rateLookups.push([from, to]);
      return rates[to] ?? null;
    },
  });

  const launch = (seed: Seed, view: LaunchView = 'home', expenseId?: number): string => {
    const group = getGroup(db, seed.asSystem);
    return encodeLaunch(
      { groupId: group.id, linkVersion: group.linkVersion, view, ...(expenseId !== undefined ? { expenseId } : {}) },
      config.linkSecret,
    );
  };

  const as = (telegramUserId: number, firstName: string, param: string): Client => {
    const call = async (method: string, path: string, body?: unknown): Promise<Reply> => {
      const response = await app.request(path, {
        method,
        headers: {
          Authorization: `tma ${initDataFor({ id: telegramUserId, first_name: firstName }, new Date())}`,
          'X-Launch': param,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      return { status: response.status, body: text === '' ? null : JSON.parse(text) };
    };
    return {
      get: (path) => call('GET', path),
      post: (path, body) => call('POST', path, body),
      put: (path, body) => call('PUT', path, body),
      patch: (path, body) => call('PATCH', path, body),
    };
  };

  return {
    db,
    config,
    app,
    a,
    b,
    notices,
    sent: () => notices.map((n) => n.name),
    clear: () => {
      notices.length = 0;
    },
    failNotices: () => {
      failing = true;
    },
    rates,
    rateLookups,
    launch,
    as,
    ana: as(101, 'Ana', launch(a)),
    sam: as(102, 'Sam', launch(a)),
  };
}

/** The body of an expense split evenly between Ana, Sam and Leo of a group, paid by Ana. */
export function dinnerBody(s: Seed, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payerId: s.ana.id,
    description: 'Dinner',
    merchant: 'Casa Pepe',
    expenseDate: '2026-09-27',
    total: 1000,
    splitType: 'even',
    shares: [{ memberId: s.ana.id }, { memberId: s.sam.id }, { memberId: s.leo.id }],
    ...over,
  };
}
