import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENCIES } from '../../src/core/index.js';
import * as dbModule from '../../src/db/index.js';
import { createExpense, inTransaction, migrate, openDatabase, type Db } from '../../src/db/index.js';
import { countActivity, dinner, seed } from './helpers.js';

const dirs: string[] = [];
const open: Db[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tripsplitter-test-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('loads the native module and runs a query', () => {
    const db = openDatabase(':memory:');
    open.push(db);
    expect(db.prepare('SELECT 1 + 1 AS n').get()).toEqual({ n: 2 });
  });

  it('uses WAL mode and foreign keys on a file, creating the folder', () => {
    const path = join(tempDir(), 'nested', 'folder', 'test.db');
    const db = openDatabase(path);
    open.push(db);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates every table', () => {
    const db = openDatabase(':memory:');
    open.push(db);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual([
      'activity',
      'agent_proposal',
      'agent_turn',
      'agent_usage',
      'chat_alias',
      'chat_group',
      'currency',
      'expense',
      'expense_item',
      'expense_photo',
      'mcp_connection',
      'mcp_pair_attempt',
      'mcp_pairing',
      'mcp_usage',
      'member',
      'migration',
      'notification_setting',
      'receipt_read',
      'settlement',
      'share',
      'trip',
      'trip_fx_rate',
    ]);
  });

  it('has the columns of the PRD', () => {
    const db = openDatabase(':memory:');
    open.push(db);
    const columns = (table: string) => (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns('chat_group')).toEqual(['id', 'chat_id', 'title', 'intro_message_id', 'link_version', 'created_at']);
    expect(columns('chat_alias')).toEqual(['id', 'group_id', 'chat_id']);
    expect(columns('member')).toEqual(['id', 'group_id', 'telegram_user_id', 'display_name', 'username', 'active', 'joined_via', 'merged_into', 'created_at']);
    expect(columns('trip')).toEqual(['id', 'group_id', 'name', 'home_currency', 'home_currency_locked', 'status', 'setup_done', 'created_at', 'ended_at']);
    expect(columns('trip_fx_rate')).toEqual(['id', 'trip_id', 'currency', 'rate', 'origin', 'set_by', 'updated_at']);
    expect(columns('expense')).toEqual([
      'id', 'trip_id', 'created_by', 'payer_id', 'description', 'merchant', 'expense_date', 'total', 'tax', 'tax_included', 'tip',
      'service_charge', 'discount', 'currency', 'currency_needs_review', 'fx_rate', 'fx_rate_source', 'split_type', 'receipt_file_id',
      'status', 'status_before_removal', 'version', 'created_at', 'updated_at', 'emoji',
    ]);
    expect(columns('expense_photo')).toEqual(['id', 'group_id', 'expense_id', 'file_key', 'width', 'height', 'bytes', 'added_by_member_id', 'created_at']);
    expect(columns('expense_item')).toEqual(['id', 'expense_id', 'label', 'quantity', 'amount', 'position']);
    expect(columns('share')).toEqual(['id', 'member_id', 'weight', 'expense_id', 'item_id']);
    expect(columns('settlement')).toEqual(['id', 'trip_id', 'created_by', 'from_member_id', 'to_member_id', 'amount', 'status', 'version', 'created_at']);
    expect(columns('activity')).toEqual(['id', 'group_id', 'trip_id', 'actor_kind', 'actor_id', 'action', 'entity_type', 'entity_id', 'before', 'after', 'created_at']);
    expect(columns('receipt_read')).toEqual(['id', 'group_id', 'day', 'created_at']);
  });

  it('records migrations and applies each one once', () => {
    const path = join(tempDir(), 'test.db');
    const first = openDatabase(path);
    expect(first.prepare('SELECT id, name FROM migration ORDER BY id').all()).toEqual([
      { id: 1, name: '001_init.sql' },
      { id: 2, name: '002_agent.sql' },
      { id: 3, name: '003_expense_emoji.sql' },
      { id: 4, name: '004_mcp.sql' },
      { id: 5, name: '005_notifications.sql' },
      { id: 6, name: '006_expense_photos.sql' },
    ]);
    expect(migrate(first)).toEqual([]);
    first.close();
    const second = openDatabase(path);
    open.push(second);
    expect(second.prepare('SELECT COUNT(*) AS n FROM migration').get()).toEqual({ n: 6 });
  });

  it('applies numbered files in order, and rolls back one that fails', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '002_second.sql'), 'ALTER TABLE a ADD COLUMN b TEXT; CREATE TABLE currency (code TEXT PRIMARY KEY, name TEXT, decimals INTEGER);');
    writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const db = openDatabase(':memory:', { migrate: false });
    open.push(db);
    expect(migrate(db, dir)).toEqual(['001_first.sql', '002_second.sql']);

    writeFileSync(join(dir, '003_broken.sql'), 'CREATE TABLE c (id INTEGER); THIS IS NOT SQL;');
    expect(() => migrate(db, dir)).toThrow();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'c'`).get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM migration').get()).toEqual({ n: 2 });
  });

  it('fills the currency table from CURRENCIES', () => {
    const db = openDatabase(':memory:');
    open.push(db);
    const rows = db.prepare('SELECT code, name, decimals FROM currency').all();
    expect(rows).toHaveLength(CURRENCIES.length);
    expect(rows).toEqual(expect.arrayContaining(CURRENCIES.map((c) => ({ ...c }))));
  });
});

describe('what src/db exports', () => {
  it('has no generic table access and no way to write activity', () => {
    const names = Object.keys(dbModule);
    for (const name of names) {
      expect(name).not.toMatch(/^(insert|update|delete|remove|write)(Row|Table|Record|Activity)?$/i);
    }
    // The list of filter kinds is a constant; the only function is the read-only listing.
    expect(names.filter((n) => /activity/i.test(n)).sort()).toEqual(['ACTIVITY_KINDS', 'listActivity']);
    expect(typeof (dbModule as Record<string, unknown>).ACTIVITY_KINDS).not.toBe('function');
    for (const required of [
      'ensureGroup', 'migrateChat', 'findGroupByChatId', 'setIntroMessage', 'resetLink',
      'upsertTelegramMember', 'setMemberActive', 'addManualMember', 'claimMember', 'listMembers',
      'getActiveTrip', 'getOrCreateActiveTrip', 'getTrip', 'listTrips', 'renameTrip', 'changeHomeCurrency', 'completeSetup', 'endTrip', 'reopenTrip',
      'listTripRates', 'setTripRate', 'previewTripRate',
      'createExpense', 'getExpense', 'listExpenses', 'saveExpense', 'confirmExpense', 'discardExpense', 'deleteExpense', 'restoreExpense', 'findPossibleDuplicates',
      'createSettlement', 'undoSettlement', 'restoreSettlement', 'listSettlements',
      'listActivity', 'reserveReceiptRead',
    ]) {
      expect(typeof (dbModule as Record<string, unknown>)[required], required).toBe('function');
    }
  });
});

describe('schema rules', () => {
  it('UPDATE and DELETE on activity fail', () => {
    const { db } = seed();
    expect(countActivity(db)).toBeGreaterThan(0);
    expect(() => db.prepare(`UPDATE activity SET action = 'x'`).run()).toThrow(/cannot be changed/);
    expect(() => db.prepare(`UPDATE activity SET "after" = NULL WHERE id = 1`).run()).toThrow(/cannot be changed/);
    expect(() => db.prepare('DELETE FROM activity').run()).toThrow(/cannot be removed/);
    expect(() => db.prepare('DELETE FROM activity WHERE id = 1').run()).toThrow(/cannot be removed/);
  });

  it('allows one active trip per group', () => {
    const { db, group } = seed();
    expect(() =>
      db.prepare(`INSERT INTO trip (group_id, name, home_currency, status, created_at) VALUES (?, 'x', 'SGD', 'active', 'now')`).run(group.id),
    ).toThrow(/UNIQUE/);
    db.prepare(`INSERT INTO trip (group_id, name, home_currency, status, created_at) VALUES (?, 'x', 'SGD', 'ended', 'now')`).run(group.id);
  });

  it('refuses an unsupported currency in the database itself', () => {
    const { db, group, trip, ana } = seed();
    expect(() =>
      db.prepare(`INSERT INTO trip (group_id, name, home_currency, status, created_at) VALUES (?, 'x', 'CHF', 'ended', 'now')`).run(group.id),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO expense (trip_id, created_by, payer_id, expense_date, total, currency, fx_rate, fx_rate_source, split_type, status, created_at, updated_at)
           VALUES (?, ?, ?, '2026-09-27', 100, 'CHF', '1.5', 'expense', 'even', 'draft', 'now', 'now')`,
        )
        .run(trip.id, ana.id, ana.id),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare(`INSERT INTO trip_fx_rate (trip_id, currency, rate, origin, set_by, updated_at) VALUES (?, 'CHF', '1.5', 'member', ?, 'now')`).run(trip.id, ana.id),
    ).toThrow(/FOREIGN KEY/);
  });

  it('wants exactly one of expense and item on a share, and a positive whole weight', () => {
    const s = seed();
    const e = createExpense(s.db, s.asAna, dinner(s));
    expect(() => s.db.prepare('INSERT INTO share (member_id, weight) VALUES (?, 1)').run(s.ana.id)).toThrow(/CHECK/);
    expect(() => s.db.prepare('INSERT INTO share (member_id, weight, expense_id) VALUES (?, 0, ?)').run(s.ana.id, e.id)).toThrow(/CHECK/);
    expect(() => s.db.prepare('INSERT INTO share (member_id, weight, expense_id) VALUES (?, 1.5, ?)').run(s.ana.id, e.id)).toThrow(/CHECK/);
  });

  it('refuses a confirmed expense without a rate, a rate of zero and an unknown source', () => {
    const { db, trip, ana } = seed();
    const insert = db.prepare(
      `INSERT INTO expense (trip_id, created_by, payer_id, expense_date, total, currency, fx_rate, fx_rate_source, split_type, status, created_at, updated_at)
       VALUES (?, ?, ?, '2026-09-27', 100, 'JPY', ?, ?, 'even', ?, 'now', 'now')`,
    );
    expect(() => insert.run(trip.id, ana.id, ana.id, null, 'missing', 'confirmed')).toThrow(/CHECK/);
    expect(() => insert.run(trip.id, ana.id, ana.id, '0', 'expense', 'draft')).toThrow(/CHECK/);
    expect(() => insert.run(trip.id, ana.id, ana.id, '112.4', 'market', 'draft')).toThrow(/CHECK/);
    insert.run(trip.id, ana.id, ana.id, null, 'missing', 'draft');
  });
});

describe('inTransaction', () => {
  it('rolls back everything, activity included, when the function throws', () => {
    const s = seed();
    const before = countActivity(s.db);
    expect(() =>
      inTransaction(s.db, () => {
        createExpense(s.db, s.asAna, dinner(s));
        createExpense(s.db, s.asAna, dinner(s, { total: -1 }));
      }),
    ).toThrow();
    expect(countActivity(s.db)).toBe(before);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM expense').get()).toEqual({ n: 0 });
  });
});
