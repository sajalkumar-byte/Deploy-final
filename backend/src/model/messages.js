'use strict';
/* repos/messages.js – one-to-one chat messages.

   Every message is a row like any other record, so it lands in the same place as the rest of the
   data: the SQLite file, or the Messages tab of the Google Sheet.

   `conversation` is the two email addresses sorted and joined, which gives each pair of people a
   single stable key and makes "show me our conversation" one cheap filter. */

const crypto = require('node:crypto');
const store = require('./store');
const { badRequest } = require('../view/http');

const MAX_LENGTH = 4000;

const normalize = e => String(e || '').trim().toLowerCase();

/** The same key whichever way round the two people are. */
function conversationKey(a, b) {
  return [normalize(a), normalize(b)].sort().join('|');
}

function toClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    from: row.fromEmail,
    to: row.toEmail,
    body: row.body,
    at: row.at,
    readAt: row.readAt || null,
  };
}

async function send({ from, to, body }) {
  const text = String(body === undefined || body === null ? '' : body).trim();
  if (!text) throw badRequest('Write a message first', 'empty_message');
  if (text.length > MAX_LENGTH) throw badRequest(`A message can be at most ${MAX_LENGTH} characters`, 'too_long');

  const sender = normalize(from);
  const recipient = normalize(to);
  if (!recipient) throw badRequest('Choose who to send it to', 'bad_recipient');
  if (sender === recipient) throw badRequest('You cannot message yourself', 'self_message');

  const row = {
    id: crypto.randomUUID(),
    conversation: conversationKey(sender, recipient),
    fromEmail: sender,
    toEmail: recipient,
    body: text,
    at: store.nowIso(),
    readAt: '',
  };
  await store.get().insert('messages', row);
  return toClient(row);
}

/** The conversation between two people, oldest first. */
async function between(a, b, { limit = 200, since = '' } = {}) {
  const rows = await store.get().filter('messages', { conversation: conversationKey(a, b) });
  const sorted = rows.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const window = since ? sorted.filter(r => String(r.at) > String(since)) : sorted;
  const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
  return window.slice(-take).map(toClient);
}

/** Mark everything the other person sent me as read. Returns how many changed. */
async function markRead(me, other) {
  const mine = normalize(me);
  const rows = await store.get().filter('messages', { conversation: conversationKey(me, other) });
  const unread = rows.filter(r => r.toEmail === mine && !r.readAt);
  const at = store.nowIso();
  for (const row of unread) {
    await store.get().update('messages', { id: row.id }, { readAt: at });
  }
  return unread.length;
}

/**
 * One line per person I have talked to, or could talk to: their last message and how many of
 * theirs I have not read. The caller supplies the directory of people.
 */
async function summary(me, people) {
  const mine = normalize(me);
  const rows = await store.get().all('messages');
  const relevant = rows.filter(r => r.fromEmail === mine || r.toEmail === mine);

  const byPerson = new Map();
  for (const row of relevant) {
    const other = row.fromEmail === mine ? row.toEmail : row.fromEmail;
    const entry = byPerson.get(other) || { last: null, unread: 0 };
    /* ">=" rather than ">": two messages can share a millisecond, and then the row that was
       written later is the later one. */
    if (!entry.last || String(row.at) >= String(entry.last.at)) entry.last = row;
    if (row.toEmail === mine && !row.readAt) entry.unread += 1;
    byPerson.set(other, entry);
  }

  return people
    .filter(p => normalize(p.email) !== mine)
    .map(p => {
      const entry = byPerson.get(normalize(p.email)) || { last: null, unread: 0 };
      return {
        email: p.email,
        name: p.name,
        role: p.role,
        unread: entry.unread,
        lastAt: entry.last ? entry.last.at : '',
        lastBody: entry.last ? String(entry.last.body).slice(0, 80) : '',
        lastFromMe: entry.last ? entry.last.fromEmail === mine : false,
      };
    })
    .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '') || a.name.localeCompare(b.name));
}

async function unreadCount(me) {
  const mine = normalize(me);
  const rows = await store.get().filter('messages', { toEmail: mine });
  return rows.filter(r => !r.readAt).length;
}

/** Used when an account is removed, so no orphan conversation is left behind. */
async function removeForEmail(email) {
  const target = normalize(email);
  const rows = await store.get().all('messages');
  let removed = 0;
  for (const row of rows) {
    if (row.fromEmail === target || row.toEmail === target) {
      removed += await store.get().remove('messages', { id: row.id });
    }
  }
  return removed;
}

module.exports = { send, between, markRead, summary, unreadCount, removeForEmail, conversationKey, toClient, MAX_LENGTH };
