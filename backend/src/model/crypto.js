'use strict';
/* crypto.js – password hashing and token generation, using only Node's built-in crypto.

   Passwords are stored as  scrypt$N$r$p$<salt base64>$<hash base64>  – a slow hash with a random
   salt per user, so the stored value cannot be reversed and two people with the same password get
   different records. Comparison is timing-safe.

   The browser build hashes a password with SHA-256 before it reaches the network in local mode;
   that is irrelevant here – whatever arrives is treated as the secret and hashed again with scrypt. */

const crypto = require('node:crypto');

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, params = PARAMS) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/*
 * The Apps Script backend writes into the same spreadsheet, and it cannot run scrypt: Apps
 * Script has no such primitive, and a memory-hard hash is not something to reimplement there.
 * So it uses repeated SHA-256 with a salt, and this is the same calculation, byte for byte.
 *
 * It matters because the two backends share a Users tab. Without this, every account created
 * through the spreadsheet would be refused here - the hash would simply be in a format this
 * file did not recognise - and pointing the server at a working sheet would lock everyone out.
 */
const SHEETS_ROUNDS = 500;

function hashPasswordSheets(password, salt, rounds = SHEETS_ROUNDS) {
  const withSalt = salt || crypto.randomBytes(12).toString('base64url');
  let digest = crypto.createHash('sha256')
    .update(`tracker:${withSalt}:${password}`, 'utf8').digest();
  for (let i = 1; i < rounds; i++) digest = crypto.createHash('sha256').update(digest).digest();
  return `sha256$${rounds}$${withSalt}$${digest.toString('hex')}`;
}

function verifySheetsPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'sha256') return false;
  const rounds = Number(parts[1]);
  if (!rounds) return false;
  const actual = Buffer.from(hashPasswordSheets(String(password), parts[2], rounds), 'utf8');
  const expected = Buffer.from(String(stored), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('sha256$')) return verifySheetsPassword(password, stored);
  if (!stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!N || !r || !p) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch { return false; }
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, {
      N, r, p, maxmem: 256 * 1024 * 1024,
    });
  } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** URL-safe random token, used for session tokens and CSRF tokens. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Session tokens are stored hashed, so a copy of the database does not hand out live sessions. */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time string comparison for CSRF tokens and similar. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = { hashPassword, hashPasswordSheets, verifyPassword, randomToken, sha256, safeEqual, PARAMS };
