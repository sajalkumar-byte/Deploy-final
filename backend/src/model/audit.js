'use strict';
/* repos/audit.js – an append-only record of who changed what.
   Every write route calls log(). Only the super admin can read it back. */

const store = require('./store');

/** Never let the audit log break the request that triggered it. */
function log({ actor = null, role = null, action, target = null, detail = null, ip = null }) {
  const row = {
    at: store.nowIso(),
    actor: actor || '',
    role: role || '',
    action: String(action),
    target: target || '',
    detail: detail == null ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    ip: ip || '',
  };
  return Promise.resolve()
    .then(() => store.get().insert('audit', row))
    .catch(() => null);
}

async function list({ limit = 200, offset = 0, action = '', actor = '' } = {}) {
  let rows = await store.get().all('audit');
  if (action) rows = rows.filter(r => r.action === action);
  if (actor) rows = rows.filter(r => r.actor === String(actor).toLowerCase());
  const take = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const skip = Math.max(Number(offset) || 0, 0);
  return rows.reverse().slice(skip, skip + take);
}

async function count() { return store.get().count('audit'); }

module.exports = { log, list, count };
