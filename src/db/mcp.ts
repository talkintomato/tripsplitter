// Connections of outside AI clients through the MCP server. A person connects a client by approving it in their
// private chat with the bot. The connection then acts as that person, in every group they are a member of.
// Codes and tokens are random, shown once, and stored only as SHA-256 hashes.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { singaporeDate } from './clock.js';
import { ValidationError } from './errors.js';
import type { Db } from './types.js';

/** No 0/O, 1/I/L: easy to read out and type. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
export const PAIRING_MINUTES = 5;
export const PAIR_ATTEMPTS_PER_HOUR = 5;

export type PairingStatus = 'pending' | 'claimed' | 'approved' | 'denied' | 'collected';
export interface McpPairing {
  id: string;
  clientName: string;
  status: PairingStatus;
  telegramUserId: number | null;
  connectionId: string | null;
  createdAt: string;
  expiresAt: string;
}
export interface McpConnection {
  id: string;
  telegramUserId: number;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** "K7QF2M9D", in the form a person may type it: case, spaces and dashes do not matter. */
export function normaliseCode(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, '');
}
export function shortCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

const pairingColumns = `id, client_name AS clientName, status, telegram_user_id AS telegramUserId, connection_id AS connectionId,
  created_at AS createdAt, expires_at AS expiresAt`;
const connectionColumns = `id, telegram_user_id AS telegramUserId, client_name AS clientName, created_at AS createdAt,
  last_used_at AS lastUsedAt, revoked_at AS revokedAt`;

function cleanClientName(name: unknown): string {
  if (typeof name !== 'string') return 'An AI client';
  const text = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return text === '' ? 'An AI client' : text;
}

/**
 * Starts a pairing for a client. Returns the code for the bot link, and the secret with which the client
 * collects its token once the person has allowed it. Neither is stored.
 */
/** How many pairings may be started in a minute, across everyone. Starting one needs no sign-in. */
export const PAIRINGS_PER_MINUTE = 30;

/** False when too many pairings were started in the last minute. Also forgets pairings that ended over a day ago. */
export function mayStartPairing(db: Db, now: Date): boolean {
  db.prepare("DELETE FROM mcp_pairing WHERE expires_at < ? AND status <> 'approved'").run(new Date(now.getTime() - 24 * 60 * 60_000).toISOString());
  db.prepare('DELETE FROM mcp_pair_attempt WHERE created_at < ?').run(new Date(now.getTime() - 24 * 60 * 60_000).toISOString());
  const row = db.prepare('SELECT COUNT(*) AS n FROM mcp_pairing WHERE created_at > ?').get(new Date(now.getTime() - 60_000).toISOString()) as { n: number };
  return row.n < PAIRINGS_PER_MINUTE;
}

export function startPairing(db: Db, input: { clientName?: unknown; now: Date }): { pairing: McpPairing; code: string; secret: string } {
  const code = newCode();
  const secret = randomBytes(24).toString('base64url');
  const id = randomUUID();
  const createdAt = input.now.toISOString();
  db.prepare(`INSERT INTO mcp_pairing (id, code_hash, secret_hash, client_name, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(
    id, hash(code), hash(secret), cleanClientName(input.clientName), createdAt,
    new Date(input.now.getTime() + PAIRING_MINUTES * 60_000).toISOString(),
  );
  return { pairing: getPairing(db, id)!, code, secret };
}

export function getPairing(db: Db, id: string): McpPairing | undefined {
  return db.prepare(`SELECT ${pairingColumns} FROM mcp_pairing WHERE id = ?`).get(id) as McpPairing | undefined;
}

/** True while this Telegram user has sent too many wrong or expired codes in the last hour. */
export function pairingPaused(db: Db, telegramUserId: number, now: Date): boolean {
  const since = new Date(now.getTime() - 60 * 60_000).toISOString();
  const row = db.prepare('SELECT COUNT(*) AS n FROM mcp_pair_attempt WHERE telegram_user_id = ? AND created_at > ?').get(telegramUserId, since) as { n: number };
  return row.n >= PAIR_ATTEMPTS_PER_HOUR;
}

export type PairingClaimResult =
  | { kind: 'claimed'; pairing: McpPairing }
  | { kind: 'paused' | 'unknown' | 'expired' | 'used' };

/**
 * A person sent a code to the bot, by the link or by typing it. The pairing becomes theirs to allow or deny.
 * A wrong, expired or used code counts toward the pause.
 */
export function claimPairing(db: Db, input: { code: string; telegramUserId: number; now: Date }): PairingClaimResult {
  return db.transaction((): PairingClaimResult => {
    if (pairingPaused(db, input.telegramUserId, input.now)) return { kind: 'paused' };
    const row = db.prepare(`SELECT ${pairingColumns} FROM mcp_pairing WHERE code_hash = ?`).get(hash(normaliseCode(input.code))) as McpPairing | undefined;
    const fail = (kind: 'unknown' | 'expired' | 'used'): PairingClaimResult => {
      db.prepare('INSERT INTO mcp_pair_attempt (telegram_user_id, created_at) VALUES (?, ?)').run(input.telegramUserId, input.now.toISOString());
      return { kind };
    };
    if (!row) return fail('unknown');
    if (row.expiresAt <= input.now.toISOString()) return fail('expired');
    // Someone else's code: it stays with them. Claiming your own code again just shows the question again.
    if (row.status !== 'pending' && !(row.status === 'claimed' && row.telegramUserId === input.telegramUserId)) return fail('used');
    db.prepare("UPDATE mcp_pairing SET status = 'claimed', telegram_user_id = ? WHERE id = ?").run(input.telegramUserId, row.id);
    return { kind: 'claimed', pairing: getPairing(db, row.id)! };
  }).immediate();
}

export type DecideResult = { kind: 'approved'; connection: McpConnection } | { kind: 'denied' } | { kind: 'not_yours' | 'expired' | 'used' };

/** Allow or Deny, pressed by the person who claimed the code. Allow creates the connection, without a token yet. */
export function decidePairing(db: Db, input: { pairingId: string; telegramUserId: number; allow: boolean; now: Date }): DecideResult {
  return db.transaction((): DecideResult => {
    const p = getPairing(db, input.pairingId);
    if (!p || p.telegramUserId !== input.telegramUserId) return { kind: 'not_yours' };
    if (p.status !== 'claimed') return { kind: 'used' };
    if (p.expiresAt <= input.now.toISOString()) return { kind: 'expired' };
    if (!input.allow) {
      db.prepare("UPDATE mcp_pairing SET status = 'denied' WHERE id = ?").run(p.id);
      return { kind: 'denied' };
    }
    const id = randomUUID();
    db.prepare('INSERT INTO mcp_connection (id, telegram_user_id, client_name, created_at) VALUES (?, ?, ?, ?)')
      .run(id, input.telegramUserId, p.clientName, input.now.toISOString());
    db.prepare("UPDATE mcp_pairing SET status = 'approved', connection_id = ? WHERE id = ?").run(id, p.id);
    return { kind: 'approved', connection: getConnection(db, id)! };
  }).immediate();
}

export type CollectResult =
  | { kind: 'token'; token: string; connection: McpConnection }
  | { kind: 'waiting' | 'denied' | 'expired' | 'unknown' | 'collected' };

/**
 * The client asks whether it was allowed. The first time the answer is yes, the token is made and handed over.
 * It is never shown again; only its hash is kept.
 */
export function collectPairing(db: Db, input: { pairingId: string; secret: string; now: Date }): CollectResult {
  return db.transaction((): CollectResult => {
    const row = db.prepare(`SELECT ${pairingColumns}, secret_hash AS secretHash FROM mcp_pairing WHERE id = ?`).get(input.pairingId) as (McpPairing & { secretHash: string }) | undefined;
    if (!row || typeof input.secret !== 'string' || row.secretHash !== hash(input.secret)) return { kind: 'unknown' };
    if (row.status === 'denied') return { kind: 'denied' };
    if (row.status === 'collected') return { kind: 'collected' };
    if (row.status !== 'approved') return row.expiresAt <= input.now.toISOString() ? { kind: 'expired' } : { kind: 'waiting' };
    const token = `ts_mcp_${randomBytes(32).toString('base64url')}`;
    db.prepare('UPDATE mcp_connection SET token_hash = ? WHERE id = ?').run(hash(token), row.connectionId);
    db.prepare("UPDATE mcp_pairing SET status = 'collected' WHERE id = ?").run(row.id);
    return { kind: 'token', token, connection: getConnection(db, row.connectionId!)! };
  }).immediate();
}

/**
 * A token for a connection created by the owner, for a client on their own machine (`pnpm mcp:token`).
 * It acts as the given Telegram user, like one approved through the bot.
 */
export function createConnectionToken(db: Db, input: { telegramUserId: number; clientName?: string; now: Date }): { token: string; connection: McpConnection } {
  if (!Number.isSafeInteger(input.telegramUserId) || input.telegramUserId <= 0) throw new ValidationError('invalid_input', 'Give a Telegram user ID.');
  const id = randomUUID();
  const token = `ts_mcp_${randomBytes(32).toString('base64url')}`;
  db.prepare('INSERT INTO mcp_connection (id, telegram_user_id, client_name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, input.telegramUserId, cleanClientName(input.clientName), hash(token), input.now.toISOString());
  return { token, connection: getConnection(db, id)! };
}

export function getConnection(db: Db, id: string): McpConnection | undefined {
  return db.prepare(`SELECT ${connectionColumns} FROM mcp_connection WHERE id = ?`).get(id) as McpConnection | undefined;
}

/** The live connection a token belongs to. Revoked and unknown tokens give nothing. Marks it as used. */
export function connectionForToken(db: Db, token: string, now: Date): McpConnection | undefined {
  if (typeof token !== 'string' || !token.startsWith('ts_mcp_')) return undefined;
  const row = db.prepare(`SELECT ${connectionColumns} FROM mcp_connection WHERE token_hash = ? AND revoked_at IS NULL`).get(hash(token)) as McpConnection | undefined;
  if (!row) return undefined;
  db.prepare('UPDATE mcp_connection SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return { ...row, lastUsedAt: now.toISOString() };
}

export function listConnections(db: Db, telegramUserId: number): McpConnection[] {
  return db.prepare(`SELECT ${connectionColumns} FROM mcp_connection WHERE telegram_user_id = ? AND revoked_at IS NULL AND token_hash IS NOT NULL
    ORDER BY created_at DESC`).all(telegramUserId) as McpConnection[];
}

/** Only the person a connection belongs to can revoke it. */
export function revokeConnection(db: Db, input: { connectionId: string; telegramUserId: number; now: Date }): boolean {
  return db.prepare('UPDATE mcp_connection SET revoked_at = ? WHERE id = ? AND telegram_user_id = ? AND revoked_at IS NULL')
    .run(input.now.toISOString(), input.connectionId, input.telegramUserId).changes === 1;
}

/** Counts one tool call against the connection's daily limit. False when the limit is reached. */
export function reserveMcpCall(db: Db, connectionId: string, cap: number, now: Date): boolean {
  return db.transaction((): boolean => {
    const day = singaporeDate(now);
    const row = db.prepare('SELECT COUNT(*) AS n FROM mcp_usage WHERE connection_id = ? AND day = ?').get(connectionId, day) as { n: number };
    if (row.n >= cap) return false;
    db.prepare('INSERT INTO mcp_usage (connection_id, day, created_at) VALUES (?, ?, ?)').run(connectionId, day, now.toISOString());
    return true;
  }).immediate();
}
