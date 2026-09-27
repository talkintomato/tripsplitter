import { createHmac, timingSafeEqual } from 'node:crypto';

/** Where a link into the Mini App leads. */
export type LaunchView = 'home' | 'add' | 'balances' | 'expense';

export const LAUNCH_VIEWS: readonly LaunchView[] = ['home', 'add', 'balances', 'expense'];

export interface Launch {
  groupId: number;
  /** The group's link version when the link was made. A link stops working when the group's link is reset. */
  linkVersion: number;
  view: LaunchView;
  /** Only with view `expense`: the expense or draft to open. */
  expenseId?: number;
}

/** Thrown by `decodeLaunch` for a parameter with the wrong form or a wrong signature. Map to HTTP 401. */
export class LaunchError extends Error {
  readonly reason: 'format' | 'signature';

  constructor(reason: 'format' | 'signature') {
    super(reason === 'format' ? 'This link is not valid.' : 'This link has a wrong signature.');
    this.name = 'LaunchError';
    this.reason = reason;
  }
}

/** Longest start parameter Telegram accepts. */
export const LAUNCH_MAX_LENGTH = 512;

const SIGNATURE_LENGTH = 22;
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function sign(text: string, secret: string): string {
  return createHmac('sha256', secret).update(text).digest('base64url').slice(0, SIGNATURE_LENGTH);
}

/**
 * The start parameter for a link: `v1_<groupId>_<linkVersion>_<view>_<expenseId or 0>_<signature>`. The
 * signature is an HMAC-SHA256 with `secret` (`config.linkSecret`) over the text before it, base64url, first
 * 22 characters. Only letters, digits, `_` and `-`, well under 512 characters. Links do not expire, and stop
 * working when the group's link is reset.
 * Throws RangeError for a launch that cannot be encoded: a bad ID, link version or view, view `expense`
 * without an expense ID, an expense ID with another view, or an empty secret.
 */
export function encodeLaunch(launch: Launch, secret: string): string {
  if (typeof secret !== 'string' || secret === '') throw new RangeError('The link secret is missing.');
  if (!isId(launch.groupId)) throw new RangeError('The group ID must be a whole number above zero.');
  if (!isId(launch.linkVersion)) throw new RangeError('The link version must be a whole number above zero.');
  if (!LAUNCH_VIEWS.includes(launch.view)) throw new RangeError(`Unknown view: ${String(launch.view)}`);
  if (launch.view === 'expense' && !isId(launch.expenseId)) throw new RangeError('The view "expense" needs an expense ID.');
  if (launch.view !== 'expense' && launch.expenseId !== undefined) {
    throw new RangeError('Only the view "expense" takes an expense ID.');
  }
  const text = `v1_${launch.groupId}_${launch.linkVersion}_${launch.view}_${launch.expenseId ?? 0}`;
  return `${text}_${sign(text, secret)}`;
}

/**
 * Reads a start parameter back and checks its signature. Throws `LaunchError` with reason `format` or
 * `signature`. Does not look at the database: whether the link version is still the group's current one is
 * checked by `resolveAccess`.
 */
export function decodeLaunch(param: string, secret: string): Launch {
  if (typeof param !== 'string' || param.length > LAUNCH_MAX_LENGTH || typeof secret !== 'string' || secret === '') {
    throw new LaunchError('format');
  }
  const match = /^(v1_([1-9]\d{0,15})_([1-9]\d{0,15})_(home|add|balances|expense)_(0|[1-9]\d{0,15}))_([A-Za-z0-9_-]{22})$/.exec(param);
  if (!match) throw new LaunchError('format');
  const [, text, groupText, versionText, view, expenseText, signature] = match as unknown as [
    string,
    string,
    string,
    string,
    LaunchView,
    string,
    string,
  ];

  const expected = Buffer.from(sign(text, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new LaunchError('signature');

  const groupId = Number(groupText);
  const linkVersion = Number(versionText);
  const expenseId = Number(expenseText);
  if (!isId(groupId) || !isId(linkVersion) || (expenseId !== 0 && !isId(expenseId))) throw new LaunchError('format');
  if ((view === 'expense') !== (expenseId !== 0)) throw new LaunchError('format');
  return expenseId === 0 ? { groupId, linkVersion, view } : { groupId, linkVersion, view, expenseId };
}

/**
 * The link for a button: `https://t.me/<BOT_USERNAME>/<MINI_APP_NAME>?startapp=<param>`.
 * Take `groupId` and `linkVersion` from the group: `{ groupId: group.id, linkVersion: group.linkVersion, view }`.
 * Throws like `encodeLaunch`.
 */
export function launchUrl(
  config: { botUsername: string; miniAppName: string; linkSecret: string },
  launch: Launch,
): string {
  return `https://t.me/${config.botUsername}/${config.miniAppName}?startapp=${encodeLaunch(launch, config.linkSecret)}`;
}
