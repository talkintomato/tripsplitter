import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { CURRENCIES } from '../core/index.js';
import { nowIso } from './clock.js';
import type { Db } from './types.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export interface OpenDatabaseOptions {
  /** Folder with the numbered .sql files. Defaults to `src/db/migrations`. */
  migrationsDir?: string;
  /** Set false to open without applying migrations. */
  migrate?: boolean;
}

/**
 * Opens the SQLite file (or `:memory:`), turns on WAL mode and foreign keys, applies pending migrations
 * and fills the `currency` table from `CURRENCIES`. Creates the folder of the file when it is missing.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Db {
  if (path !== ':memory:' && path !== '') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (options.migrate !== false) migrate(db, options.migrationsDir);
  return db;
}

/**
 * Applies every migration file not yet recorded in the `migration` table, in the order of their number,
 * each in its own transaction, then syncs the `currency` table. Returns the names of the files applied.
 */
export function migrate(db: Db, migrationsDir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS migration (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  )`);

  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .map((name) => ({ name, id: Number.parseInt(name, 10) }))
    .sort((a, b) => a.id - b.id);
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.id === files[i - 1]!.id) {
      throw new Error(`Two migrations have the number ${files[i]!.id}: ${files[i - 1]!.name} and ${files[i]!.name}`);
    }
  }

  const applied = new Set(
    (db.prepare('SELECT id FROM migration').all() as Array<{ id: number }>).map((row) => row.id),
  );
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file.id)) continue;
    const sql = readFileSync(join(migrationsDir, file.name), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO migration (id, name, applied_at) VALUES (?, ?, ?)').run(file.id, file.name, nowIso());
    })();
    done.push(file.name);
  }

  syncCurrencies(db);
  return done;
}

/** Copies `CURRENCIES` into the `currency` table, which the currency columns reference. */
function syncCurrencies(db: Db): void {
  const upsert = db.prepare(
    `INSERT INTO currency (code, name, decimals) VALUES (?, ?, ?)
     ON CONFLICT (code) DO UPDATE SET name = excluded.name, decimals = excluded.decimals`,
  );
  db.transaction(() => {
    for (const currency of CURRENCIES) upsert.run(currency.code, currency.name, currency.decimals);
  })();
}

/**
 * Runs `fn` in one transaction and returns its result. If `fn` throws, everything it did is rolled back,
 * activity entries included. Can be nested: repository functions called inside join the outer transaction.
 * `fn` must not be async.
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}
