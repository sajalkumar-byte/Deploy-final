'use strict';
/* repos/requests.js – people who opened the tracker but have no account yet.
   The super admin sees them in the Users dialog and can approve them with a role. */

const store = require('./store');

async function list() { return store.get().all('requests'); }

async function put(id, { email = '', name = '' } = {}) {
  const key = String(id).slice(0, 120);
  if (await store.get().find('requests', { id: key })) return { id: key, existing: true };
  await store.get().insert('requests', {
    id: key,
    email: String(email || '').toLowerCase().slice(0, 200),
    name: String(name || '').slice(0, 120),
    at: store.nowIso(),
  });
  return { id: key, existing: false };
}

async function remove(id) {
  await store.get().remove('requests', { id: String(id) });
  return { id: String(id) };
}

async function count() { return store.get().count('requests'); }

module.exports = { list, put, remove, count };
