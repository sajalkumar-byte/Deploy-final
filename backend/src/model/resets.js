'use strict';
/* repos/resets.js – the one-time codes emailed by the "forgot password" flow.
   Only the hash of a code is stored, so the data never holds a usable code. */

const crypto = require('node:crypto');
const store = require('./store');
const config = require('../config');
const { sha256 } = require('./crypto');

const normalize = e => String(e || '').trim().toLowerCase();

/** A six-digit code from a cryptographic source, not Math.random. */
function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

const hashCode = (email, code) => sha256(`reset:${normalize(email)}:${String(code)}`);

/** Replace any previous code for this address with a fresh one. */
async function create(email, code) {
  const target = normalize(email);
  const expiresAt = new Date(Date.now() + config.resetCodeMinutes * 60000).toISOString();
  const row = { email: target, codeHash: hashCode(target, code), expiresAt, attempts: '0', createdAt: store.nowIso() };
  const existing = await store.get().find('resets', { email: target });
  if (existing) await store.get().update('resets', { email: target }, row);
  else await store.get().insert('resets', row);
  return { email: target, expiresAt };
}

async function find(email) { return store.get().find('resets', { email: normalize(email) }); }

async function bumpAttempts(email) {
  const row = await find(email);
  if (!row) return 0;
  const next = (Number(row.attempts) || 0) + 1;
  await store.get().update('resets', { email: normalize(email) }, { attempts: String(next) });
  return next;
}

async function remove(email) {
  await store.get().remove('resets', { email: normalize(email) });
}

async function purgeExpired() {
  return store.get().removeWhereLessOrEqual('resets', 'expiresAt', store.nowIso());
}

/**
 * Check a submitted code. Returns {ok:true} or {ok:false, code, message}: enough for the person
 * to understand, without revealing more than they need.
 */
async function verify(email, code) {
  const row = await find(email);
  if (!row) return { ok: false, code: 'bad_code', message: 'No code is waiting for that address – ask for a new one' };

  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    await remove(email);
    return { ok: false, code: 'expired_code', message: 'That code has expired – ask for a new one' };
  }
  const attempts = Number(row.attempts) || 0;
  if (attempts >= config.resetMaxTries) {
    await remove(email);
    return { ok: false, code: 'too_many_tries', message: 'Too many wrong codes – ask for a new one' };
  }
  const expected = Buffer.from(String(row.codeHash));
  const actual = Buffer.from(hashCode(email, String(code).replace(/\s+/g, '')));
  const same = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!same) {
    await bumpAttempts(email);
    const left = config.resetMaxTries - (attempts + 1);
    return {
      ok: false, code: 'bad_code',
      message: left > 0 ? `That code is not correct – ${left} tries left` : 'That code is not correct',
    };
  }
  return { ok: true };
}

module.exports = { newCode, hashCode, create, find, verify, remove, purgeExpired, bumpAttempts };
