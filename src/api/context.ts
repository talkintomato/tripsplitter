import type { Context } from 'hono';
import type { Config } from '../config.js';
import type { Launch, Notifier, RateSuggester } from '../core/index.js';
import { NotFoundError, type Db, type Group, type Member, type Scope } from '../db/index.js';

/** What the API needs from the other builds. Tests pass fakes. */
export interface ApiDeps {
  downloadPhoto?: (fileId: string) => Promise<Uint8Array>;
  notifier: Notifier;
  suggestRate: RateSuggester;
}

/** Who is calling and for which group. Built by the access middleware, never from a request body. */
export interface Caller {
  scope: Scope;
  member: Member;
  group: Group;
  launch: Launch;
}

export type ApiEnv = { Variables: { caller: Caller } };
export type ApiContext = Context<ApiEnv>;

/** Everything a route needs that does not change between requests. */
export interface Services {
  config: Config;
  db: Db;
  deps: ApiDeps;
}

/** A record ID from the path. Anything that is not a positive whole number behaves as not found. */
export function idParam(c: ApiContext, name: string, entityType: string): number {
  const raw = c.req.param(name) ?? '';
  if (!/^[1-9]\d{0,14}$/.test(raw)) throw new NotFoundError(entityType, raw);
  return Number(raw);
}
