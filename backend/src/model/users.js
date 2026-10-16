'use strict';
/* repos/users.js – sign-in accounts. Works the same whether the rows live in SQLite or in a
   Google Sheet; it only ever talks to the storage layer.
   A password hash never leaves this module: publicUser() strips it. */

const store = require('./store');
const { hashPassword, hashPasswordSheets } = require('./crypto');
const { ROLES } = require('./permissions');
const { badRequest, conflict, notFound } = require('../view/http');

const normalizeEmail = e => String(e || '').trim().toLowerCase();

/* The browser builds its document id by replacing runs of non-alphanumeric characters with an
   underscore. The same id is used here so the existing frontend addresses the same records. */
const docId = email => normalizeEmail(email).replace(/[^a-z0-9]+/g, '_') || 'x';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function publicUser(row) {
  if (!row) return null;
  return {
    id: docId(row.email),
    email: row.email,
    name: row.name,
    role: row.role,
    externalId: row.externalId || '',
    at: String(row.createdAt || '').slice(0, 10),
    by: row.createdBy || '',
    updatedAt: row.updatedAt || null,
    lastLogin: row.lastLogin || null,
  };
}

async function list() {
  const rows = await store.get().all('users');
  return rows
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }))
    .map(publicUser);
}

/** Internal: the full row including the password hash. Only auth should use this. */
async function rawByEmail(email) {
  return store.get().find('users', { email: normalizeEmail(email) });
}

async function byEmail(email) { return publicUser(await rawByEmail(email)); }

async function byDocId(id) {
  const rows = await store.get().all('users');
  return publicUser(rows.find(u => docId(u.email) === String(id)));
}

async function byExternalId(externalId) {
  if (!externalId) return null;
  return publicUser(await store.get().find('users', { externalId: String(externalId) }));
}

async function count() { return store.get().count('users'); }
async function countByRole(role) { return store.get().count('users', { role }); }

function validate({ email, name, role, password }, { requirePassword = true } = {}) {
  const e = normalizeEmail(email);
  const n = String(name || '').trim();
  if (!EMAIL_RE.test(e)) throw badRequest('Enter a valid email address', 'bad_email');
  if (!n) throw badRequest('Enter a name', 'bad_name');
  if (n.length > 120) throw badRequest('That name is too long', 'bad_name');
  if (!ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(', ')}`, 'bad_role');
  if (requirePassword) {
    const p = String(password || '');
    if (p.length < 4) throw badRequest('The password must be at least 4 characters', 'bad_password');
    if (p.length > 200) throw badRequest('That password is too long', 'bad_password');
  }
  return { email: e, name: n, role };
}

/**
 * Hash a password in whichever format the storage can be read with.
 *
 * scrypt is the stronger hash and what this server uses by default. But a spreadsheet is also
 * read by the Apps Script backend, which has no scrypt and never will, so an account created
 * here with one would be unusable there. On a sheet, both must be able to read it.
 */
function hashFor(password) {
  return store.get().kind === 'sheets' ? hashPasswordSheets(password) : hashPassword(password);
}

async function create({ email, name, role, password, externalId, createdBy }) {
  const clean = validate({ email, name, role, password });
  if (await rawByEmail(clean.email)) throw conflict('This email already has an account');
  await store.get().insert('users', {
    email: clean.email, name: clean.name, role: clean.role,
    password: hashFor(password), externalId: externalId || '',
    createdAt: store.nowIso(), createdBy: createdBy || '', updatedAt: '', lastLogin: '',
  });
  return byEmail(clean.email);
}

/** Patch a user. `patch` may contain name, role, password, externalId. */
async function update(email, patch = {}) {
  const current = await rawByEmail(email);
  if (!current) throw notFound('No account with that email');

  const changes = {};
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw badRequest('Enter a name', 'bad_name');
    changes.name = n;
  }
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) throw badRequest(`Role must be one of: ${ROLES.join(', ')}`, 'bad_role');
    /* The last super admin may not lose the role, or nobody could manage users again. */
    if (current.role === 'superadmin' && patch.role !== 'superadmin' && (await countByRole('superadmin')) <= 1) {
      throw badRequest('This is the only super admin – promote someone else first', 'last_superadmin');
    }
    changes.role = patch.role;
  }
  if (patch.password !== undefined) {
    const p = String(patch.password);
    if (p.length < 4) throw badRequest('The password must be at least 4 characters', 'bad_password');
    changes.password = hashFor(p);
  }
  if (patch.externalId !== undefined) changes.externalId = patch.externalId || '';
  if (!Object.keys(changes).length) return publicUser(current);

  changes.updatedAt = store.nowIso();
  await store.get().update('users', { email: current.email }, changes);
  return byEmail(current.email);
}

async function remove(email) {
  const current = await rawByEmail(email);
  if (!current) throw notFound('No account with that email');
  if (current.role === 'superadmin' && (await countByRole('superadmin')) <= 1) {
    throw badRequest('This is the only super admin – add another one first', 'last_superadmin');
  }
  await store.get().remove('users', { email: current.email });
  return { email: current.email };
}

async function touchLogin(email) {
  await store.get().update('users', { email: normalizeEmail(email) }, { lastLogin: store.nowIso() });
}

module.exports = {
  normalizeEmail, docId, publicUser, list, byEmail, byDocId, byExternalId, rawByEmail,
  count, countByRole, validate, create, update, remove, touchLogin, EMAIL_RE,
};
