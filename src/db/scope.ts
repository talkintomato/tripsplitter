import type { Actor, Scope } from './types.js';

/** The actor for changes made by Telegram events or by the bot itself. */
export const SYSTEM_ACTOR: Actor = { kind: 'system' };

/** A scope acting as the system. */
export function systemScope(groupId: number): Scope {
  return { groupId, actor: SYSTEM_ACTOR };
}

/** A scope acting as a member. */
export function memberScope(groupId: number, memberId: number): Scope {
  return { groupId, actor: { kind: 'member', memberId } };
}
