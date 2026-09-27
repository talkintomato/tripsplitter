import { randomUUID } from 'node:crypto';
import { getGroup, listGroupsForTelegramUser } from './groups.js';
import { getMember } from './members.js';
import { singaporeDate } from './clock.js';
import { PermissionError, ValidationError } from './errors.js';
import type { Db, Scope } from './types.js';

export type ProposalStatus = 'pending' | 'done' | 'cancelled' | 'expired';
export interface AgentProposal {
  id: string; groupId: number; memberId: number; chatId: number; messageId: number | null;
  actions: unknown[]; summary: string; versions: unknown; status: ProposalStatus;
  createdAt: string; expiresAt: string;
}
function actor(db: Db, scope: Scope): number {
  getGroup(db, scope);
  if (scope.actor.kind !== 'member' || getMember(db, scope, scope.actor.memberId).mergedInto !== null) throw new PermissionError();
  return scope.actor.memberId;
}
function stamp(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ValidationError('invalid_input', 'The time is not valid.');
  return now.toISOString();
}
const columns = `id, group_id AS groupId, member_id AS memberId, chat_id AS chatId, message_id AS messageId,
 actions, summary, versions, status, created_at AS createdAt, expires_at AS expiresAt`;
/** Replaces pending proposals for this person/chat atomically. Only validated plans belong here. */
export function createProposal(db: Db, scope: Scope, input: { chatId: number; messageId?: number; actions: unknown[]; summary: string; versions: unknown; now: Date }): AgentProposal {
  const memberId = actor(db, scope);
  const createdAt = stamp(input.now);
  return db.transaction(() => {
    const telegramId = getMember(db, scope, memberId).telegramUserId;
    db.prepare(`UPDATE agent_proposal SET status = 'cancelled' WHERE chat_id = ? AND status = 'pending'
      AND (member_id = ? OR member_id IN (SELECT id FROM member WHERE telegram_user_id = ?))`)
      .run(input.chatId, memberId, telegramId);
    const id = randomUUID();
    db.prepare(`INSERT INTO agent_proposal VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
      id, scope.groupId, memberId, input.chatId, input.messageId ?? null, JSON.stringify(input.actions), input.summary,
      JSON.stringify(input.versions), createdAt, new Date(input.now.getTime() + 15 * 60_000).toISOString());
    return getProposal(db, id)!;
  })();
}
/** Trusted callback lookup only. Caller must check memberId before exposing the contents. */
export function getProposal(db: Db, id: string): AgentProposal | undefined {
  const row = db.prepare(`SELECT ${columns} FROM agent_proposal WHERE id = ?`).get(id) as (Omit<AgentProposal, 'actions' | 'versions'> & { actions: string; versions: string }) | undefined;
  return row ? { ...row, actions: JSON.parse(row.actions), versions: JSON.parse(row.versions) } : undefined;
}
/** Compare-and-set; cannot reopen or finish a proposal belonging to someone else. */
export function finishProposal(db: Db, scope: Scope, id: string, status: Exclude<ProposalStatus, 'pending'>): boolean {
  const memberId = actor(db, scope);
  return db.prepare("UPDATE agent_proposal SET status = ? WHERE id = ? AND group_id = ? AND member_id = ? AND status = 'pending'")
    .run(status, id, scope.groupId, memberId).changes === 1;
}
export interface AgentTurn { role: 'user' | 'assistant'; content: string; createdAt: string }
/** Eight individual user/assistant turns per person/chat, isolated further by group. */
export function appendTurn(db: Db, scope: Scope, chatId: number, role: AgentTurn['role'], content: string, now: Date): void {
  const memberId = actor(db, scope);
  db.transaction(() => {
    forgetExpiredTurns(db, now);
    db.prepare('INSERT INTO agent_turn(group_id,member_id,chat_id,role,content,created_at) VALUES(?,?,?,?,?,?)')
      .run(scope.groupId, memberId, chatId, role, content, stamp(now));
    const telegramId = getMember(db, scope, memberId).telegramUserId;
    db.prepare(`DELETE FROM agent_turn WHERE chat_id = ? AND role <> 'chosen_group'
      AND (member_id = ? OR member_id IN (SELECT id FROM member WHERE telegram_user_id = ?)) AND id NOT IN
      (SELECT id FROM agent_turn WHERE chat_id = ? AND role <> 'chosen_group'
       AND (member_id = ? OR member_id IN (SELECT id FROM member WHERE telegram_user_id = ?)) ORDER BY id DESC LIMIT 8)`)
      .run(chatId, memberId, telegramId, chatId, memberId, telegramId);
  })();
}
export function recentTurns(db: Db, scope: Scope, chatId: number, now: Date): AgentTurn[] {
  const memberId = actor(db, scope);
  forgetExpiredTurns(db, now);
  return db.prepare(`SELECT role, content, created_at AS createdAt FROM agent_turn WHERE member_id = ? AND chat_id = ?
    AND role <> 'chosen_group' ORDER BY id`).all(memberId, chatId) as AgentTurn[];
}
/** Expire the whole conversation after 30 minutes idle, rather than aging each turn separately. */
export function forgetExpiredTurns(db: Db, now: Date): number {
  stamp(now);
  return db.prepare(`DELETE FROM agent_turn WHERE role <> 'chosen_group' AND id IN (
    SELECT t.id FROM agent_turn t JOIN member m ON m.id = t.member_id WHERE t.role <> 'chosen_group'
    AND (COALESCE('telegram:' || m.telegram_user_id, 'member:' || m.id), t.chat_id) IN (
      SELECT COALESCE('telegram:' || m2.telegram_user_id, 'member:' || m2.id), t2.chat_id
      FROM agent_turn t2 JOIN member m2 ON m2.id = t2.member_id WHERE t2.role <> 'chosen_group'
      GROUP BY COALESCE('telegram:' || m2.telegram_user_id, 'member:' || m2.id), t2.chat_id HAVING MAX(t2.created_at) <= ?))`)
    .run(new Date(now.getTime() - 30 * 60_000).toISOString()).changes;
}
export function reserveAgentMessage(db: Db, groupId: number, cap: number, now: Date, globalCap = 0): boolean {
  for (const value of [cap, globalCap]) if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError('invalid_input', 'The cap must be a whole number, zero or more.');
  const createdAt = stamp(now);
  return db.transaction(() => {
    getGroup(db, { groupId, actor: { kind: 'system' } });
    const day = singaporeDate(now);
    const count = db.prepare('SELECT COUNT(*) AS n FROM agent_usage WHERE group_id = ? AND day = ?').get(groupId, day) as { n: number };
    const global = db.prepare('SELECT COUNT(*) AS n FROM agent_usage WHERE day = ?').get(day) as { n: number };
    if (count.n >= cap || (globalCap > 0 && global.n >= globalCap)) return false;
    db.prepare('INSERT INTO agent_usage(group_id,day,created_at) VALUES(?,?,?)').run(groupId, day, createdAt);
    return true;
  }).immediate();
}
/** A selection is keyed by authenticated Telegram identity/chat, across that person's memberships. */
export function rememberChosenGroup(db: Db, scope: Scope, chatId: number, now: Date): void {
  const memberId = actor(db, scope);
  const member = getMember(db, scope, memberId);
  if (member.telegramUserId === null) throw new PermissionError();
  db.transaction(() => {
    db.prepare(`DELETE FROM agent_turn WHERE role = 'chosen_group' AND chat_id = ? AND member_id IN
      (SELECT id FROM member WHERE telegram_user_id = ?)`).run(chatId, member.telegramUserId);
    db.prepare("INSERT INTO agent_turn(group_id,member_id,chat_id,role,content,created_at) VALUES(?,?,?,'chosen_group','',?)")
      .run(scope.groupId, memberId, chatId, stamp(now));
  })();
}
export function chosenGroup(db: Db, telegramUserId: number, chatId: number): { groupId: number; memberId: number } | undefined {
  const memberships = listGroupsForTelegramUser(db, telegramUserId);
  const row = db.prepare(`SELECT t.group_id AS groupId,t.member_id AS memberId FROM agent_turn t JOIN member m ON m.id=t.member_id
    WHERE t.role='chosen_group' AND t.chat_id=? AND m.telegram_user_id=? ORDER BY t.id DESC LIMIT 1`).get(chatId, telegramUserId) as { groupId: number; memberId: number } | undefined;
  return row && memberships.some(({ member }) => member.id === row.memberId) ? row : undefined;
}
