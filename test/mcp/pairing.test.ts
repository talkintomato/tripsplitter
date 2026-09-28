import { describe, expect, it } from 'vitest';
import {
  claimPairing, collectPairing, connectionForToken, createConnectionToken, decidePairing, listConnections, openDatabase,
  pairingPaused, revokeConnection, startPairing,
} from '../../src/db/index.js';

const NOW = new Date('2026-09-28T04:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe('pairing a client', () => {
  it('is claimed by the person who sends the code, allowed by them, and hands over a token once', () => {
    const db = openDatabase(':memory:');
    const { pairing, code, secret } = startPairing(db, { clientName: 'Claude', now: NOW });
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(collectPairing(db, { pairingId: pairing.id, secret, now: NOW }).kind).toBe('waiting');

    // Typed with a dash and in lower case, as a person might.
    const claimed = claimPairing(db, { code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`, telegramUserId: 101, now: later(1) });
    expect(claimed).toMatchObject({ kind: 'claimed', pairing: { clientName: 'Claude', telegramUserId: 101 } });
    // Someone else cannot take it over, or allow it.
    expect(claimPairing(db, { code, telegramUserId: 999, now: later(1) }).kind).toBe('used');
    expect(decidePairing(db, { pairingId: pairing.id, telegramUserId: 999, allow: true, now: later(1) }).kind).toBe('not_yours');

    expect(decidePairing(db, { pairingId: pairing.id, telegramUserId: 101, allow: true, now: later(2) }).kind).toBe('approved');
    // Only the client that started it can collect, with its secret.
    expect(collectPairing(db, { pairingId: pairing.id, secret: 'wrong', now: later(2) }).kind).toBe('unknown');
    const collected = collectPairing(db, { pairingId: pairing.id, secret, now: later(2) });
    expect(collected.kind).toBe('token');
    const token = collected.kind === 'token' ? collected.token : '';
    expect(token).toMatch(/^ts_mcp_/);
    expect(collectPairing(db, { pairingId: pairing.id, secret, now: later(3) }).kind).toBe('collected');

    // The token is stored only as a hash.
    const stored = db.prepare('SELECT token_hash FROM mcp_connection').all() as Array<{ token_hash: string }>;
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(db.prepare('SELECT * FROM mcp_pairing').all())).not.toContain(code);

    expect(connectionForToken(db, token, later(4))).toMatchObject({ telegramUserId: 101, clientName: 'Claude', lastUsedAt: later(4).toISOString() });
    expect(listConnections(db, 101)).toHaveLength(1);
  });

  it('gives nothing when denied, when expired, or for a reused code', () => {
    const db = openDatabase(':memory:');
    const denied = startPairing(db, { clientName: 'Claude', now: NOW });
    claimPairing(db, { code: denied.code, telegramUserId: 101, now: NOW });
    expect(decidePairing(db, { pairingId: denied.pairing.id, telegramUserId: 101, allow: false, now: NOW }).kind).toBe('denied');
    expect(collectPairing(db, { pairingId: denied.pairing.id, secret: denied.secret, now: NOW }).kind).toBe('denied');
    expect(claimPairing(db, { code: denied.code, telegramUserId: 101, now: NOW }).kind).toBe('used');

    const old = startPairing(db, { now: NOW });
    expect(claimPairing(db, { code: old.code, telegramUserId: 101, now: later(6) }).kind).toBe('expired');
    expect(collectPairing(db, { pairingId: old.pairing.id, secret: old.secret, now: later(6) }).kind).toBe('expired');

    // Allowed too late.
    const slow = startPairing(db, { now: NOW });
    claimPairing(db, { code: slow.code, telegramUserId: 101, now: later(1) });
    expect(decidePairing(db, { pairingId: slow.pairing.id, telegramUserId: 101, allow: true, now: later(6) }).kind).toBe('expired');
    expect(listConnections(db, 101)).toEqual([]);
  });

  it('pauses a person after five codes that do not work in an hour', () => {
    const db = openDatabase(':memory:');
    for (let i = 0; i < 5; i++) expect(claimPairing(db, { code: 'ZZZZZZZZ', telegramUserId: 101, now: later(i) }).kind).toBe('unknown');
    expect(pairingPaused(db, 101, later(5))).toBe(true);
    const good = startPairing(db, { now: later(5) });
    expect(claimPairing(db, { code: good.code, telegramUserId: 101, now: later(6) }).kind).toBe('paused');
    // Someone else is not paused, and the pause ends after an hour.
    expect(pairingPaused(db, 102, later(6))).toBe(false);
    expect(pairingPaused(db, 101, later(61))).toBe(false);
  });

  it('can be revoked only by its person, after which the token does nothing', () => {
    const db = openDatabase(':memory:');
    const { token, connection } = createConnectionToken(db, { telegramUserId: 101, clientName: 'Local', now: NOW });
    expect(connectionForToken(db, token, NOW)?.id).toBe(connection.id);
    expect(revokeConnection(db, { connectionId: connection.id, telegramUserId: 102, now: NOW })).toBe(false);
    expect(revokeConnection(db, { connectionId: connection.id, telegramUserId: 101, now: NOW })).toBe(true);
    expect(connectionForToken(db, token, NOW)).toBeUndefined();
    expect(connectionForToken(db, 'ts_mcp_unknown', NOW)).toBeUndefined();
    expect(listConnections(db, 101)).toEqual([]);
  });
});

describe('starting pairings', () => {
  it('is limited per minute, and forgets old ones', async () => {
    const { mayStartPairing, PAIRINGS_PER_MINUTE } = await import('../../src/db/index.js');
    const db = openDatabase(':memory:');
    for (let i = 0; i < PAIRINGS_PER_MINUTE; i++) startPairing(db, { now: NOW });
    expect(mayStartPairing(db, NOW)).toBe(false);
    expect(mayStartPairing(db, later(2))).toBe(true);
    expect(mayStartPairing(db, later(60 * 25))).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM mcp_pairing').get() as { n: number }).n).toBe(0);
  });
});
