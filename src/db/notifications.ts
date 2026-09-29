import { nowIso } from './clock.js';
import { ValidationError } from './errors.js';
import { mapMember, openForRead, openForWrite, requireMemberActor } from './internal.js';
import { systemScope } from './scope.js';
import type { Db, Member, Scope } from './types.js';

export const GROUP_NOTICE_TYPES = ['expense_added', 'expense_changed', 'expense_removed', 'payment', 'exchange_rate', 'trip', 'member_joined'] as const;
export const PERSONAL_NOTICE_TYPES = ['added_me', 'changed_mine', 'payments_me', 'exchange_rate', 'draft_waiting'] as const;
export type GroupNoticeType = typeof GROUP_NOTICE_TYPES[number];
export type PersonalNoticeType = typeof PERSONAL_NOTICE_TYPES[number];
export type GroupNotificationSettings = Record<GroupNoticeType, boolean>;
export type PersonalNotificationSettings = Record<PersonalNoticeType, boolean>;

function validateType(kind: 'group' | 'personal', type: string): void {
  const types: readonly string[] = kind === 'group' ? GROUP_NOTICE_TYPES : PERSONAL_NOTICE_TYPES;
  if (!types.includes(type)) throw new ValidationError('invalid_input', 'Unknown notification type.');
}
function settings(db: Db, scope: Scope, kind: 'group' | 'personal', memberId: number | null): Record<string, boolean> {
  openForRead(db, scope);
  const types = kind === 'group' ? GROUP_NOTICE_TYPES : PERSONAL_NOTICE_TYPES;
  const result: Record<string, boolean> = Object.fromEntries(types.map(type => [type, kind === 'group']));
  const rows = db.prepare('SELECT type, enabled FROM notification_setting WHERE group_id = ? AND member_id IS ? AND kind = ?')
    .all(scope.groupId, memberId, kind) as Array<{ type: string; enabled: number }>;
  for (const row of rows) result[row.type] = row.enabled === 1;
  return result;
}
export function getGroupNotificationSettings(db: Db, scope: Scope): GroupNotificationSettings {
  return settings(db, scope, 'group', null) as GroupNotificationSettings;
}
export function getMyNotificationSettings(db: Db, scope: Scope): PersonalNotificationSettings {
  return settings(db, scope, 'personal', requireMemberActor(scope)) as PersonalNotificationSettings;
}
function set(db: Db, scope: Scope, kind: 'group' | 'personal', type: string, enabled: boolean): void {
  validateType(kind, type);
  if (typeof enabled !== 'boolean') throw new ValidationError('invalid_input', 'Enabled must be true or false.');
  db.transaction(() => {
    openForWrite(db, scope);
    const actor = requireMemberActor(scope);
    const memberId = kind === 'personal' ? actor : null;
    const before = settings(db, scope, kind, memberId)[type]!;
    if (before === enabled) return;
    db.prepare('DELETE FROM notification_setting WHERE group_id = ? AND member_id IS ? AND kind = ? AND type = ?')
      .run(scope.groupId, memberId, kind, type);
    if (enabled !== (kind === 'group')) {
      db.prepare('INSERT INTO notification_setting (group_id, member_id, kind, type, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(scope.groupId, memberId, kind, type, Number(enabled), nowIso());
    }
    // Keep this new action local to the new operation; personal settings never enter activity.
    if (kind === 'group') db.prepare(`INSERT INTO activity
      (group_id, actor_kind, actor_id, action, entity_type, entity_id, "before", "after", created_at)
      VALUES (?, 'member', ?, 'group.notification', 'group', ?, ?, ?, ?)`)
      .run(scope.groupId, actor, scope.groupId, JSON.stringify({ type, enabled: before }), JSON.stringify({ type, enabled }), nowIso());
  })();
}
export function setGroupNotification(db: Db, scope: Scope, type: string, enabled: boolean): void {
  set(db, scope, 'group', type, enabled);
}
export function setMyNotification(db: Db, scope: Scope, type: string, enabled: boolean): void {
  set(db, scope, 'personal', type, enabled);
}
export function isGroupNoticeEnabled(db: Db, groupId: number, type: GroupNoticeType): boolean {
  validateType('group', type);
  return getGroupNotificationSettings(db, systemScope(groupId))[type];
}
export function personalRecipients(db: Db, groupId: number, type: PersonalNoticeType, memberIds: readonly number[]): Member[] {
  validateType('personal', type);
  openForRead(db, systemScope(groupId));
  const concerned = new Set(memberIds);
  return db.prepare(`SELECT m.* FROM member m JOIN notification_setting n ON n.member_id = m.id AND n.group_id = m.group_id
    WHERE m.group_id = ? AND n.kind = 'personal' AND n.type = ? AND n.enabled = 1
    AND m.telegram_user_id IS NOT NULL AND m.active = 1 AND m.merged_into IS NULL ORDER BY m.id`)
    .all(groupId, type).map(mapMember).filter(member => concerned.has(member.id));
}
