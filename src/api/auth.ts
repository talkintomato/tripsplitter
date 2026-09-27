import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { Launch } from '../core/index.js';
import {
  findMemberByTelegramId,
  getGroup,
  NotFoundError,
  systemScope,
  upsertTelegramMember,
  type Db,
  type Group,
  type Member,
} from '../db/index.js';

/** The Telegram user behind a Mini App request. */
export interface TelegramUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
}

export type InitDataFailure = 'malformed' | 'bad_signature' | 'expired' | 'bot';

/** Thrown by `verifyInitData` and `authenticate`. Map to HTTP 401. */
export class InitDataError extends Error {
  readonly reason: InitDataFailure;

  constructor(reason: InitDataFailure, message: string) {
    super(message);
    this.name = 'InitDataError';
    this.reason = reason;
  }
}

/** Sign-in data older than this is rejected: 24 hours, in seconds. */
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Checks the signature of the Mini App's `initData` (the raw query string of `Telegram.WebApp.initData`)
 * against the bot token, and returns the Telegram user.
 * Throws `InitDataError` with reason `malformed` (no signature, no date or no user), `bad_signature`,
 * `expired` (older than 24 hours at `now`, or dated more than 5 minutes after it) or `bot` (the user is
 * flagged as a bot).
 */
export function verifyInitData(initData: string, botToken: string, now: Date): TelegramUser {
  if (typeof initData !== 'string' || initData === '' || typeof botToken !== 'string' || botToken === '') {
    throw new InitDataError('malformed', 'Missing sign-in data.');
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new InitDataError('malformed', 'The sign-in data has no signature.');

  const dataCheckString = [...params]
    .filter(([key]) => key !== 'hash')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(hash, expected)) throw new InitDataError('bad_signature', 'The sign-in data has a wrong signature.');

  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) throw new InitDataError('malformed', 'The sign-in data has no date.');
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (nowSeconds - authDate > INIT_DATA_MAX_AGE_SECONDS || authDate - nowSeconds > 300) {
    throw new InitDataError('expired', 'The sign-in data is too old. Open the app again from the group.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(params.get('user') ?? '');
  } catch {
    throw new InitDataError('malformed', 'The sign-in data has no user.');
  }
  if (typeof raw !== 'object' || raw === null) throw new InitDataError('malformed', 'The sign-in data has no user.');
  const user = raw as Record<string, unknown>;
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new InitDataError('malformed', 'The sign-in data has no user.');
  }
  if (user.is_bot === true) throw new InitDataError('bot', 'Bots cannot use the app.');
  return {
    id: user.id,
    firstName: typeof user.first_name === 'string' ? user.first_name : '',
    ...(typeof user.last_name === 'string' && user.last_name !== '' ? { lastName: user.last_name } : {}),
    ...(typeof user.username === 'string' && user.username !== '' ? { username: user.username } : {}),
    ...(typeof user.language_code === 'string' ? { languageCode: user.language_code } : {}),
  };
}

/**
 * The Telegram user of a request. Normally `verifyInitData` with `config.botToken`.
 * In development only (`config.nodeEnv` is `development`), when `config.devFakeUser` is set, the check is
 * bypassed and that user is returned whatever `initData` holds. In `test` and `production` the fake user is
 * never used, and a config with both `DEV_FAKE_USER` and production cannot be loaded at all.
 */
export function authenticate(config: Config, initData: string | null | undefined, now: Date): TelegramUser {
  if (config.nodeEnv === 'development' && config.devFakeUser) return { ...config.devFakeUser };
  return verifyInitData(initData ?? '', config.botToken, now);
}

/** The name shown for a Telegram user: first and last name, else the username, else "User <id>". */
export function displayNameOf(user: TelegramUser): string {
  const name = [user.firstName, user.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .trim();
  return name || user.username || `User ${user.id}`;
}

/** `write`: a member, who may do everything. `none`: refused. There is no read-only level. */
export type AccessLevel = 'write' | 'none';

export interface AccessResult {
  level: AccessLevel;
  /** The caller's member in the group. Set for `write`, missing for `none`. */
  member?: Member;
  /** The group of the link. Set for `write`, missing for `none`. */
  group?: Group;
  /** True when this call made the caller a member. The API then calls `notifier.memberJoinedByLink` once. */
  joined: boolean;
}

/**
 * Decides what a Telegram user may do with a link. `launch` comes from `decodeLaunch`, which has checked
 * its signature. Holding a valid link is what grants access: there is no check against the Telegram chat.
 * 1. The group of the link does not exist, or the link's `linkVersion` is not the group's current one
 *    (the link is from before a reset): `none`.
 * 2. The user is a member of the group, active or not: `write`.
 * 3. Otherwise the user becomes a member, joined via `link` and active, recorded with the system actor:
 *    `write`, with `joined` true.
 * Never gives access to a bot: `verifyInitData` rejects them before this is called.
 * Activity: `member.add` when the caller joined, otherwise none. The name of an existing member is not
 * updated here.
 * For the actor of later operations use `memberScope(launch.groupId, result.member.id)`.
 */
export function resolveAccess(db: Db, telegramUser: TelegramUser, launch: Launch): AccessResult {
  const scope = systemScope(launch.groupId);
  let group: Group;
  try {
    group = getGroup(db, scope);
  } catch (error) {
    if (error instanceof NotFoundError) return { level: 'none', joined: false };
    throw error;
  }
  if (launch.linkVersion !== group.linkVersion) return { level: 'none', joined: false };

  const known = findMemberByTelegramId(db, scope, telegramUser.id);
  if (known) return { level: 'write', member: known, group, joined: false };

  const { member, created } = upsertTelegramMember(
    db,
    scope,
    { telegramUserId: telegramUser.id, displayName: displayNameOf(telegramUser), username: telegramUser.username ?? null },
    { joinedVia: 'link' },
  );
  return { level: 'write', member, group, joined: created };
}
