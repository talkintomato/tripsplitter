import {
  addManualMember,
  ensureGroup,
  memberScope,
  openDatabase,
  systemScope,
  type CreateExpenseInput,
  type Db,
  type Group,
  type Member,
  type Scope,
  type Trip,
} from '../../src/db/index.js';

export interface Seed {
  db: Db;
  group: Group;
  trip: Trip;
  /** Telegram user 101 */
  ana: Member;
  /** Telegram user 102 */
  sam: Member;
  /** Added by hand, no Telegram account */
  leo: Member;
  asAna: Scope;
  asSam: Scope;
  asSystem: Scope;
}

/** A group with Ana and Sam from Telegram, Leo added by hand, and an active trip in SGD. */
export function seedGroup(db: Db, chatId = -1001234567890, title = 'Japan 2026', firstUser = 101): Seed {
  const result = ensureGroup(db, chatId, title, [
    { telegramUserId: firstUser, displayName: 'Ana', username: 'ana' },
    { telegramUserId: firstUser + 1, displayName: 'Sam' },
  ]);
  const [ana, sam] = result.members as [Member, Member];
  const group = result.group;
  const asAna = memberScope(group.id, ana.id);
  const leo = addManualMember(db, asAna, 'Leo');
  return { db, group, trip: result.trip!, ana, sam, leo, asAna, asSam: memberScope(group.id, sam.id), asSystem: systemScope(group.id) };
}

export function seed(): Seed {
  return seedGroup(openDatabase(':memory:'));
}

/** Two groups in one database, for checks that one cannot reach into the other. */
export function seedTwo(): { db: Db; a: Seed; b: Seed } {
  const db = openDatabase(':memory:');
  return { db, a: seedGroup(db), b: seedGroup(db, -1009876543210, 'Bali 2026', 201) };
}

export function countActivity(db: Db, groupId?: number): number {
  const row = (
    groupId === undefined
      ? db.prepare('SELECT COUNT(*) AS n FROM activity').get()
      : db.prepare('SELECT COUNT(*) AS n FROM activity WHERE group_id = ?').get(groupId)
  ) as { n: number };
  return row.n;
}

export interface Logged {
  action: string;
  entityType: string;
  entityId: number;
  actorKind: string;
  actorId: number | null;
  tripId: number | null;
  before: unknown;
  after: unknown;
}

/** Runs `fn` and returns the activity entries it wrote, oldest first. */
export function logged(db: Db, fn: () => unknown): Logged[] {
  const { last } = db.prepare('SELECT COALESCE(MAX(id), 0) AS last FROM activity').get() as { last: number };
  fn();
  const rows = db.prepare('SELECT * FROM activity WHERE id > ? ORDER BY id').all(last) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    action: r.action as string,
    entityType: r.entity_type as string,
    entityId: r.entity_id as number,
    actorKind: r.actor_kind as string,
    actorId: r.actor_id as number | null,
    tripId: r.trip_id as number | null,
    before: r.before === null ? null : JSON.parse(r.before as string),
    after: r.after === null ? null : JSON.parse(r.after as string),
  }));
}

/** A fingerprint of every row of every table, to prove that a refused call changed nothing. */
export function fingerprint(db: Db): string {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all()]));
}

export const dinner = (s: Seed, over: Partial<CreateExpenseInput> = {}): CreateExpenseInput => ({
  tripId: s.trip.id,
  payerId: s.ana.id,
  description: 'Dinner',
  merchant: 'Casa Pepe',
  expenseDate: '2026-09-27',
  total: 1000,
  splitType: 'even',
  shares: [{ memberId: s.ana.id }, { memberId: s.sam.id }, { memberId: s.leo.id }],
  ...over,
});

export const ramen = (s: Seed, over: Partial<CreateExpenseInput> = {}): CreateExpenseInput =>
  dinner(s, { payerId: s.sam.id, description: 'Ramen', merchant: 'Ichiran', total: 11240, currency: 'JPY', ...over });

/** The fields of a save that repeat what the expense already holds. */
export const sameAs = (s: Seed, input: CreateExpenseInput) => {
  const { tripId: _tripId, status: _status, currency: _currency, rateOverride: _rate, ...rest } = input;
  return rest;
};
