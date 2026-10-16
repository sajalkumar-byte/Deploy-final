'use strict';
/* chat.test.js – one-to-one chat: the HTTP endpoints and the live Socket.IO side.

   Two real socket clients connect to a real server, so delivery, presence, typing and read
   receipts are exercised over an actual WebSocket rather than mocked. */

process.env.DB_FILE = ':memory:';
process.env.SERVE_STATIC = '0';
process.env.LOG_REQUESTS = '0';
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'memory';
process.env.SEED_TEST_ADMIN = '0';
process.env.SEED_SUPERADMIN_EMAIL = 'boss@tracker.com';
process.env.SEED_SUPERADMIN_PASSWORD = 'Boss@1234';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/presenter/app');
const store = require('../src/model/store');
const { io: ioClient } = require('socket.io-client');

let server, base, live;
const tokens = {};

test.before(async () => {
  server = await createApp({ initDb: true });
  live = server.live;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  /* one account per role, so the chat can be tried from every side */
  tokens.boss = await login('boss@tracker.com', 'Boss@1234');
  const people = [
    { email: 'amina@example.com', name: 'Amina', role: 'admin', password: 'adminpw' },
    { email: 'sohel@example.com', name: 'Sohel', role: 'superuser', password: 'superpw' },
    { email: 'vik@example.com', name: 'Vik', role: 'viewer', password: 'viewerpw' },
  ];
  for (const person of people) {
    const res = await call('POST', '/api/users', { token: tokens.boss, body: person });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  tokens.admin = await login('amina@example.com', 'adminpw');
  tokens.superuser = await login('sohel@example.com', 'superpw');
  tokens.viewer = await login('vik@example.com', 'viewerpw');
});

test.after(async () => {
  if (live) await live.close();
  await new Promise(r => server.close(r));
  await store.close();
});

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const login = async (email, password) =>
  (await call('POST', '/api/auth/login', { body: { email, password } })).body.token;

/** Connect a socket and wait until it is either ready or refused. */
function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(base, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', err => reject(err));
    setTimeout(() => reject(new Error('socket did not connect in time')), 8000);
  });
}

/** Keep every copy of an event, so one that arrives before we look is not missed. */
function collect(socket, event) {
  const seen = [];
  socket.on(event, payload => seen.push(payload));
  return seen;
}

/** Poll a condition until it holds, or give up. */
async function until(check, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('condition was never met');
}

/** Wait for one event, with a deadline so a missing message fails rather than hangs. */
function once(socket, event, ms = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "${event}" within ${ms}ms`)), ms);
    socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
  });
}

/* ---------------------------------------------------------------- contacts */
test('everyone can see everyone else as a contact, but not themselves', async () => {
  const res = await call('GET', '/api/chat/contacts', { token: tokens.viewer });
  assert.equal(res.status, 200);
  const emails = res.body.contacts.map(c => c.email).sort();
  assert.deepEqual(emails, ['amina@example.com', 'boss@tracker.com', 'sohel@example.com']);
  assert.ok(!emails.includes('vik@example.com'), 'you are not in your own contact list');
  assert.equal(res.body.me.email, 'vik@example.com');
  assert.equal(res.body.realtime, true, 'the live side is available');
});

test('chat needs a sign-in', async () => {
  for (const [method, path] of [['GET', '/api/chat/contacts'], ['GET', '/api/chat/with/boss@tracker.com'], ['GET', '/api/chat/unread']]) {
    assert.equal((await call(method, path)).status, 401, `${method} ${path}`);
  }
  assert.equal((await call('POST', '/api/chat/with/boss@tracker.com', { body: { body: 'hello' } })).status, 401);
});

/* ---------------------------------------------------------------- sending over HTTP */
test('a message sent over HTTP is stored and comes back in the conversation', async () => {
  const sent = await call('POST', '/api/chat/with/amina@example.com', {
    token: tokens.viewer, body: { body: 'Hello Amina, can you look at P-1?' },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.from, 'vik@example.com');
  assert.equal(sent.body.to, 'amina@example.com');
  assert.equal(sent.body.readAt, null);

  /* both sides see the same single conversation */
  const mine = await call('GET', '/api/chat/with/amina@example.com', { token: tokens.viewer });
  assert.equal(mine.body.messages.length, 1);
  const theirs = await call('GET', '/api/chat/with/vik@example.com', { token: tokens.admin });
  assert.equal(theirs.body.messages.length, 1);
  assert.equal(theirs.body.messages[0].body, 'Hello Amina, can you look at P-1?');
});

test('a conversation is private to the two people in it', async () => {
  const outsider = await call('GET', '/api/chat/with/amina@example.com', { token: tokens.superuser });
  assert.equal(outsider.status, 200);
  assert.equal(outsider.body.messages.length, 0,
    'Sohel sees his own empty conversation with Amina, not the one Vik is having');
});

test('unread counts go up, then clear when the conversation is opened', async () => {
  await call('POST', '/api/chat/with/amina@example.com', { token: tokens.viewer, body: { body: 'second' } });

  const before = await call('GET', '/api/chat/unread', { token: tokens.admin });
  assert.ok(before.body.unread >= 1, `expected unread messages, got ${before.body.unread}`);

  const contacts = await call('GET', '/api/chat/contacts', { token: tokens.admin });
  const fromVik = contacts.body.contacts.find(c => c.email === 'vik@example.com');
  assert.ok(fromVik.unread >= 1);
  assert.equal(fromVik.lastBody, 'second');
  assert.equal(fromVik.lastFromMe, false);

  await call('GET', '/api/chat/with/vik@example.com', { token: tokens.admin });
  assert.equal((await call('GET', '/api/chat/unread', { token: tokens.admin })).body.unread, 0);
});

test('empty, oversized and self-addressed messages are refused', async () => {
  assert.equal((await call('POST', '/api/chat/with/amina@example.com', {
    token: tokens.viewer, body: { body: '   ' },
  })).body.error.code, 'empty_message');

  assert.equal((await call('POST', '/api/chat/with/amina@example.com', {
    token: tokens.viewer, body: { body: 'x'.repeat(5000) },
  })).body.error.code, 'too_long');

  assert.equal((await call('POST', '/api/chat/with/vik@example.com', {
    token: tokens.viewer, body: { body: 'talking to myself' },
  })).body.error.code, 'self_message');

  assert.equal((await call('POST', '/api/chat/with/nobody@example.com', {
    token: tokens.viewer, body: { body: 'hello?' },
  })).status, 404);
});

test('every role may chat, including a viewer', async () => {
  for (const [token, to] of [[tokens.viewer, 'sohel@example.com'], [tokens.superuser, 'boss@tracker.com'], [tokens.boss, 'vik@example.com']]) {
    const res = await call('POST', `/api/chat/with/${to}`, { token, body: { body: 'hi' } });
    assert.equal(res.status, 201, `${to}: ${JSON.stringify(res.body)}`);
  }
});

/* ---------------------------------------------------------------- live sockets */
test('a socket without a valid token is refused', async () => {
  await assert.rejects(() => connect('not-a-real-token'), /sign in/i);
  await assert.rejects(() => connect(''), /sign in/i);
});

test('two people exchange messages live over the socket', async () => {
  const a = await connect(tokens.viewer);          // Vik
  const b = await connect(tokens.admin);           // Amina
  try {
    const arriving = once(b, 'chat:message');
    const echo = once(a, 'chat:message');

    const ack = await new Promise(resolve =>
      a.emit('chat:send', { to: 'amina@example.com', body: 'live hello' }, resolve));
    assert.equal(ack.ok, true, JSON.stringify(ack));

    const received = await arriving;
    assert.equal(received.body, 'live hello');
    assert.equal(received.from, 'vik@example.com');

    const mirrored = await echo;
    assert.equal(mirrored.id, received.id, 'the sender sees it too, so other tabs stay in step');

    /* and it was really stored, not just broadcast */
    const history = await call('GET', '/api/chat/with/vik@example.com', { token: tokens.admin });
    assert.ok(history.body.messages.some(m => m.body === 'live hello'));
  } finally {
    a.close(); b.close();
  }
});

test('presence lists who is connected, and updates when someone leaves', async () => {
  /* The listener must be in place before the socket finishes connecting, or the very first
     presence packet is gone before anything is watching for it. */
  const a = ioClient(base, { auth: { token: tokens.superuser }, transports: ['websocket'], reconnection: false });
  const seen = collect(a, 'presence');
  await new Promise((resolve, reject) => { a.once('connect', resolve); a.once('connect_error', reject); });
  try {
    await until(() => seen.some(p => p.online.includes('sohel@example.com')));

    const b = await connect(tokens.boss);
    await until(() => seen[seen.length - 1].online.includes('boss@tracker.com'));

    b.close();
    await until(() => !seen[seen.length - 1].online.includes('boss@tracker.com'));
  } finally {
    a.close();
  }
});

test('typing is passed to the other person and never stored', async () => {
  const a = await connect(tokens.viewer);
  const b = await connect(tokens.admin);
  try {
    const typing = once(b, 'chat:typing');
    a.emit('chat:typing', { to: 'amina@example.com', typing: true });
    const event = await typing;
    assert.equal(event.from, 'vik@example.com');
    assert.equal(event.typing, true);

    const rows = await store.get().all('messages');
    assert.ok(!rows.some(r => String(r.body).includes('typing')), 'nothing about typing is written down');
  } finally {
    a.close(); b.close();
  }
});

test('a read receipt reaches the sender', async () => {
  const a = await connect(tokens.viewer);          // Vik sends
  const b = await connect(tokens.admin);           // Amina reads
  try {
    await new Promise(resolve => a.emit('chat:send', { to: 'amina@example.com', body: 'please read' }, resolve));
    const receipt = once(a, 'chat:read');
    await new Promise(resolve => b.emit('chat:read', { from: 'vik@example.com' }, resolve));
    const event = await receipt;
    assert.equal(event.by, 'amina@example.com');

    const history = await call('GET', '/api/chat/with/amina@example.com', { token: tokens.viewer });
    const last = history.body.messages[history.body.messages.length - 1];
    assert.ok(last.readAt, 'the message is marked read in storage too');
  } finally {
    a.close(); b.close();
  }
});

test('a socket cannot send on behalf of someone else', async () => {
  const a = await connect(tokens.viewer);
  try {
    const ack = await new Promise(resolve =>
      a.emit('chat:send', { to: 'nobody@example.com', body: 'hello' }, resolve));
    assert.equal(ack.ok, false);

    /* the sender is taken from the session, never from the payload */
    const ack2 = await new Promise(resolve =>
      a.emit('chat:send', { to: 'amina@example.com', from: 'boss@tracker.com', body: 'spoofed' }, resolve));
    assert.equal(ack2.ok, true);
    assert.equal(ack2.message.from, 'vik@example.com', 'the claimed sender is ignored');
  } finally {
    a.close();
  }
});

test('removing an account removes their conversations', async () => {
  await call('POST', '/api/users', {
    token: tokens.boss, body: { email: 'temp@example.com', name: 'Temp', role: 'viewer', password: 'temppw1' },
  });
  const tempToken = await login('temp@example.com', 'temppw1');
  await call('POST', '/api/chat/with/vik@example.com', { token: tempToken, body: { body: 'hello there' } });

  const before = await store.get().all('messages');
  assert.ok(before.some(m => m.fromEmail === 'temp@example.com'));

  await call('DELETE', '/api/users/temp@example.com', { token: tokens.boss });

  const after = await store.get().all('messages');
  assert.ok(!after.some(m => m.fromEmail === 'temp@example.com' || m.toEmail === 'temp@example.com'),
    'no orphan conversation is left behind');
});

test('messages are stored as ordinary rows, so they go wherever the data goes', async () => {
  const rows = await store.get().all('messages');
  assert.ok(rows.length > 0);
  const row = rows[0];
  for (const column of ['id', 'conversation', 'fromEmail', 'toEmail', 'body', 'at', 'readAt']) {
    assert.ok(column in row, `a message row carries ${column}`);
  }
  assert.match(row.conversation, /^[^|]+\|[^|]+$/, 'the pair key is both addresses, sorted');
});

test('a socket can also sign in with the session cookie, as a reloaded page does', async () => {
  /* Sign in the way a browser does, keeping the cookie rather than the token. */
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'vik@example.com', password: 'viewerpw' }),
  });
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map(c => c.split(';')[0]).join('; ');
  assert.match(cookies, /tracker_session=/);

  const socket = ioClient(base, {
    transports: ['websocket'], reconnection: false,
    extraHeaders: { Cookie: cookies },       // no token at all
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      setTimeout(() => reject(new Error('did not connect')), 8000);
    });
    const ack = await new Promise(resolve =>
      socket.emit('chat:send', { to: 'amina@example.com', body: 'sent with only a cookie' }, resolve));
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.equal(ack.message.from, 'vik@example.com');
  } finally {
    socket.close();
  }
});
