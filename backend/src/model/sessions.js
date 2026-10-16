'use strict';
/* repos/sessions.js – active sign-ins.
   The token the browser holds is random; only its SHA-256 is stored, so a copy of the data
   cannot be replayed as a live session. */

const store = require('./store');
const config = require('../config');
const { randomToken, sha256 } = require('./crypto');

async function create(email, { userAgent = '', ip = '' } = {}) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionTtlHours * 3600 * 1000);
  await store.get().insert('sessions', {
    tokenHash: sha256(token),
    email: String(email).toLowerCase(),
    csrf,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    userAgent: String(userAgent).slice(0, 300),
    ip: String(ip).slice(0, 60),
  });
  return { token, csrf, expiresAt: expires.toISOString() };
}

/** Look a session up by its raw token. Returns null when missing or expired. */
async function find(token) {
  if (!token) return null;
  const hash = sha256(token);
  const row = await store.get().find('sessions', { tokenHash: hash });
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    await store.get().remove('sessions', { tokenHash: hash });
    return null;
  }
  return row;
}

/** Slide the expiry forward so an active person is not signed out mid-session. */
async function touch(token) {
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();
  await store.get().update('sessions', { tokenHash: sha256(token) }, { expiresAt });
  return expiresAt;
}

async function destroy(token) {
  if (!token) return 0;
  return store.get().remove('sessions', { tokenHash: sha256(token) });
}

/** Sign a person out everywhere – when their role changes or their account is removed. */
async function destroyForEmail(email) {
  return store.get().remove('sessions', { email: String(email).toLowerCase() });
}

/** Sign a person out everywhere except the session they are using right now. */
async function destroyOthers(email, keepToken) {
  const target = String(email).toLowerCase();
  const keep = sha256(keepToken || '');
  const rows = await store.get().filter('sessions', { email: target });
  let removed = 0;
  for (const row of rows) {
    if (row.tokenHash === keep) continue;
    removed += await store.get().remove('sessions', { tokenHash: row.tokenHash });
  }
  return removed;
}

async function listForEmail(email) {
  const rows = await store.get().filter('sessions', { email: String(email).toLowerCase() });
  return rows
    .map(r => ({ created_at: r.createdAt, expires_at: r.expiresAt, user_agent: r.userAgent, ip: r.ip }))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Housekeeping: drop sessions whose expiry has passed. */
async function purgeExpired() {
  return store.get().removeWhereLessOrEqual('sessions', 'expiresAt', store.nowIso());
}

module.exports = { create, find, touch, destroy, destroyForEmail, destroyOthers, listForEmail, purgeExpired };
