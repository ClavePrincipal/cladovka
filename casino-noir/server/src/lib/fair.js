import crypto from 'node:crypto';
import { fail } from './errors.js';

/**
 * Provably fair RNG.
 * float_i = uint32(HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}:${round}`)[4i..4i+4]) / 2^32
 * The SHA-256 of serverSeed is shown before play; serverSeed is revealed when the player rotates seeds.
 */
export function floatsFor(serverSeed, clientSeed, nonce, n) {
  const out = [];
  for (let round = 0; out.length < n; round++) {
    const h = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${round}`).digest();
    for (let i = 0; i + 4 <= h.length && out.length < n; i += 4) out.push(h.readUInt32BE(i) / 2 ** 32);
  }
  return out;
}

const newSeed = () => {
  const server = crypto.randomBytes(32).toString('hex');
  return { server, hash: crypto.createHash('sha256').update(server).digest('hex') };
};

export async function activeSeed(c, userId, { lock = false } = {}) {
  let r = await c.query(`SELECT * FROM fair_seeds WHERE user_id = $1 AND active ${lock ? 'FOR UPDATE' : ''}`, [userId]);
  if (r.rowCount) return r.rows[0];
  const s = newSeed();
  r = await c.query(
    `INSERT INTO fair_seeds (user_id, server_seed, server_hash, client_seed) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) WHERE active DO NOTHING RETURNING *`,
    [userId, s.server, s.hash, crypto.randomBytes(8).toString('hex')]);
  if (r.rowCount) return r.rows[0];
  return (await c.query(`SELECT * FROM fair_seeds WHERE user_id = $1 AND active ${lock ? 'FOR UPDATE' : ''}`, [userId])).rows[0];
}

/** Consumes one nonce and returns n floats in [0,1). */
export async function nextFloats(c, userId, n) {
  const seed = await activeSeed(c, userId, { lock: true });
  const r = await c.query('UPDATE fair_seeds SET nonce = nonce + 1 WHERE id = $1 RETURNING nonce', [seed.id]);
  const nonce = r.rows[0].nonce;
  return { seedId: seed.id, nonce, floats: floatsFor(seed.server_seed, seed.client_seed, nonce, n) };
}

export async function rotate(c, userId, clientSeed) {
  const open = await c.query(`SELECT 1 FROM game_rounds WHERE user_id = $1 AND status = 'open' LIMIT 1`, [userId]);
  if (open.rowCount) fail('ROUND_OPEN', 'Завершите открытую игру (Мины или Crash) перед сменой сида', 409);
  const cur = await activeSeed(c, userId, { lock: true });
  await c.query('UPDATE fair_seeds SET active = false, revealed_at = now() WHERE id = $1', [cur.id]);
  const s = newSeed();
  await c.query('INSERT INTO fair_seeds (user_id, server_seed, server_hash, client_seed) VALUES ($1,$2,$3,$4)',
    [userId, s.server, s.hash, clientSeed || crypto.randomBytes(8).toString('hex')]);
  return { revealed: { serverSeed: cur.server_seed, serverHash: cur.server_hash, clientSeed: cur.client_seed, nonce: cur.nonce } };
}

export const publicSeed = s => ({ serverHash: s.server_hash, clientSeed: s.client_seed, nonce: s.nonce });
