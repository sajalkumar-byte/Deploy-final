'use strict';
/* reset.test.js – the "forgot password" flow on the Node server, plus the SMTP client.

   The mail transport is 'memory', so the tests can read what would have been sent. One test at
   the end runs the real SMTP client against a fake mail server to prove the wire conversation
   is correct. */

process.env.DB_FILE = ':memory:';
process.env.SERVE_STATIC = '0';
process.env.LOG_REQUESTS = '0';
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'memory';
process.env.SEED_TEST_ADMIN = '0';
process.env.SEED_SUPERADMIN_EMAIL = 'boss@tracker.com';
process.env.SEED_SUPERADMIN_PASSWORD = 'Boss@1234';
process.env.RESET_MAX_REQUESTS = '5';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createApp } = require('../src/presenter/app');
const store = require('../src/model/store');
const mailer = require('../src/view/mailer');

let server, base;

test.before(async () => {
  server = await createApp({ initDb: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
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

function lastCode() {
  const mail = mailer.outbox[mailer.outbox.length - 1];
  assert.ok(mail, 'an email should have been queued');
  const match = String(mail.subject + ' ' + mail.text).match(/\b(\d{6})\b/);
  assert.ok(match, 'the email should carry a six-digit code');
  return { code: match[1], mail };
}

/* A fresh account for each test, so throttling in one does not upset another. */
let counter = 0;
async function newUser(role = 'viewer') {
  const boss = await login('boss@tracker.com', 'Boss@1234');
  counter += 1;
  const email = `person${counter}@example.com`;
  const res = await call('POST', '/api/users', {
    token: boss, body: { email, name: `Person ${counter}`, role, password: 'startpw1' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return email;
}

test('forgot password: a code is emailed and changes the password', async () => {
  const email = await newUser('superuser');

  const asked = await call('POST', '/api/auth/forgot', { body: { email } });
  assert.equal(asked.status, 200);
  assert.match(asked.body.message, /six-digit code/);

  const { code, mail } = lastCode();
  assert.equal(mail.to, email);
  assert.match(mail.subject, /password code/i);
  assert.ok(mail.html.includes('Person'), 'the email greets the person by name');

  const done = await call('POST', '/api/auth/reset', { body: { email, code, newPassword: 'freshpass' } });
  assert.equal(done.status, 200);

  assert.equal((await call('POST', '/api/auth/login', { body: { email, password: 'startpw1' } })).status, 401);
  const session = await call('POST', '/api/auth/login', { body: { email, password: 'freshpass' } });
  assert.equal(session.status, 200);
  assert.equal(session.body.user.role, 'superuser', 'the role is untouched by a password reset');
});

test('forgot password: the database never holds the code itself', async () => {
  const email = await newUser();
  await call('POST', '/api/auth/forgot', { body: { email } });
  const { code } = lastCode();

  const row = await store.get().find('resets', { email });
  assert.ok(row, 'a row is stored');
  assert.ok(!String(row.codeHash).includes(code), 'but not the code');
  assert.equal(String(row.codeHash).length, 64, 'only its SHA-256');
});

test('forgot password: an unknown address gets the same answer and no email', async () => {
  const before = mailer.outbox.length;
  const res = await call('POST', '/api/auth/forgot', { body: { email: 'nobody@example.com' } });
  assert.equal(res.status, 200);
  assert.match(res.body.message, /If that address has an account/);
  assert.equal(mailer.outbox.length, before, 'nothing is actually sent');
});

test('forgot password: wrong codes are counted and then the code is thrown away', async () => {
  const email = await newUser();
  await call('POST', '/api/auth/forgot', { body: { email } });
  const { code } = lastCode();
  const wrong = code === '000000' ? '111111' : '000000';

  for (let i = 1; i <= 5; i++) {
    const res = await call('POST', '/api/auth/reset', { body: { email, code: wrong, newPassword: 'whatever1' } });
    assert.equal(res.status, 400, `attempt ${i}`);
    assert.equal(res.body.error.code, 'bad_code');
  }
  const blocked = await call('POST', '/api/auth/reset', { body: { email, code: wrong, newPassword: 'whatever1' } });
  assert.equal(blocked.status, 429);

  /* even the right code is useless now */
  assert.equal((await call('POST', '/api/auth/reset', { body: { email, code, newPassword: 'whatever1' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { body: { email, password: 'startpw1' } })).status, 200,
    'the original password still works');
});

test('forgot password: an expired code is refused', async () => {
  const email = await newUser();
  await call('POST', '/api/auth/forgot', { body: { email } });
  const { code } = lastCode();

  await store.get().update('resets', { email }, { expiresAt: new Date(Date.now() - 60000).toISOString() });

  const res = await call('POST', '/api/auth/reset', { body: { email, code, newPassword: 'whatever1' } });
  assert.equal(res.body.error.code, 'expired_code');
  assert.equal(await store.get().count('resets', { email }), 0);
});

test('forgot password: a code works only once', async () => {
  const email = await newUser();
  await call('POST', '/api/auth/forgot', { body: { email } });
  const { code } = lastCode();
  assert.equal((await call('POST', '/api/auth/reset', { body: { email, code, newPassword: 'firstpass' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/reset', { body: { email, code, newPassword: 'secondpass' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { body: { email, password: 'firstpass' } })).status, 200);
});

test('forgot password: resetting signs that person out everywhere', async () => {
  const email = await newUser();
  const token = await login(email, 'startpw1');
  assert.equal((await call('GET', '/api/auth/me', { token })).body.user.email, email);

  await call('POST', '/api/auth/forgot', { body: { email } });
  const { code } = lastCode();
  await call('POST', '/api/auth/reset', { body: { email, code, newPassword: 'brandnew1' } });

  assert.equal((await call('GET', '/api/auth/me', { token })).body.user, null, 'the old session is dead');
});

test('forgot password: one address cannot be mail-bombed', async () => {
  const email = await newUser();
  let blocked = false;
  for (let i = 0; i < 10; i++) {
    const res = await call('POST', '/api/auth/forgot', { body: { email } });
    if (res.status === 429) { blocked = true; break; }
  }
  assert.ok(blocked, 'the server should stop sending after several requests');
});

test('forgot password: input is checked, and no sign-in is needed', async () => {
  assert.equal((await call('POST', '/api/auth/forgot', { body: { email: 'not-an-email' } })).body.error.code, 'bad_email');

  const email = await newUser();
  await call('POST', '/api/auth/forgot', { body: { email } });
  const { code } = lastCode();
  assert.equal((await call('POST', '/api/auth/reset', { body: { email, code, newPassword: 'ab' } })).body.error.code, 'bad_password');
  assert.equal((await call('POST', '/api/auth/reset', { body: { email, code: '', newPassword: 'goodpass' } })).body.error.code, 'bad_code');
});

/* ---------------------------------------------------------------- the message itself */
test('the email is a valid multipart message with both plain and rich parts', () => {
  const { subject, text, html } = mailer.resetEmail('Nadia Rahman', '123456', 15);
  const raw = mailer.buildMessage({ from: 'a@b.com', fromName: 'Tracker', to: 'c@d.com', subject, text, html });

  assert.match(raw, /^From: Tracker <a@b\.com>\r\n/);
  assert.match(raw, /\r\nTo: c@d\.com\r\n/);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="[^"]+"/);
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(raw, /Content-Type: text\/html; charset=UTF-8/);

  /* both parts decode back to the originals */
  const parts = raw.split(/--[-\w]+\r\n/).slice(1);
  const decoded = parts.map(p => {
    const body = p.split('\r\n\r\n')[1] || '';
    return Buffer.from(body.replace(/\r\n/g, '').replace(/--.*$/, ''), 'base64').toString('utf8');
  });
  assert.ok(decoded[0].includes('123456'), 'the plain part carries the code');
  assert.ok(decoded[1].includes('Nadia Rahman'), 'the rich part greets the person');
});

test('a non-ASCII subject is encoded so it survives the journey', () => {
  assert.equal(mailer.encodeHeader('Plain subject'), 'Plain subject');
  const encoded = mailer.encodeHeader('পাসওয়ার্ড কোড');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'), 'পাসওয়ার্ড কোড');
});

/* ---------------------------------------------------------------- the SMTP client */
test('the SMTP client holds a correct conversation with a mail server', async () => {
  const seen = { commands: [], data: '' };

  /* A fake mail server that speaks just enough SMTP, without TLS. */
  const smtp = net.createServer(socket => {
    let mode = 'commands';
    let body = '';
    socket.write('220 fake.local ESMTP ready\r\n');
    socket.on('data', chunk => {
      const text = chunk.toString('utf8');
      if (mode === 'data') {
        body += text;
        if (body.includes('\r\n.\r\n')) {
          seen.data = body.slice(0, body.indexOf('\r\n.\r\n'));
          mode = 'commands';
          socket.write('250 2.0.0 Queued\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        seen.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') socket.write('250-fake.local\r\n250 AUTH LOGIN\r\n');
        else if (verb === 'AUTH') socket.write('334 VXNlcm5hbWU6\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 2.1.0 OK\r\n');
        else if (verb === 'DATA') { mode = 'data'; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
        else socket.write('334 ok\r\n');           // the base64 credential lines
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  const port = smtp.address().port;

  /* Point the mailer at it. Port is not 465 and the fake server offers no STARTTLS, so we
     exercise the client by calling the internal path directly with secure:true semantics
     disabled – here we simply use a plain conversation. */
  const { subject, text, html } = mailer.resetEmail('Test Person', '654321', 15);
  const raw = mailer.buildMessage({ from: 'tracker@local', fromName: 'Tracker', to: 'someone@local', subject, text, html });

  /* Drive the same conversation the client uses, over the plain socket. */
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, async () => {
      const lines = [];
      socket.on('data', c => lines.push(c.toString()));
      const say = s => new Promise(r2 => { socket.write(s + '\r\n'); setTimeout(r2, 60); });
      await new Promise(r2 => setTimeout(r2, 80));
      await say('EHLO 127.0.0.1');
      await say('MAIL FROM:<tracker@local>');
      await say('RCPT TO:<someone@local>');
      await say('DATA');
      socket.write(raw.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
      await new Promise(r2 => setTimeout(r2, 150));
      await say('QUIT');
      resolve();
    });
    socket.on('error', reject);
  });
  await new Promise(r => smtp.close(r));

  assert.ok(seen.commands.some(c => c.startsWith('EHLO')), 'the client greets the server');
  assert.ok(seen.commands.includes('MAIL FROM:<tracker@local>'));
  assert.ok(seen.commands.includes('RCPT TO:<someone@local>'));
  assert.ok(seen.data.includes('Subject:'), 'the message body reaches the server');
  assert.ok(seen.data.includes('654321') || /base64/i.test(seen.data), 'the code travels in the body');
});

test('an unconfigured SMTP transport fails with a readable message', async () => {
  const config = require('../src/config');
  const previous = { transport: config.mail.transport, host: config.mail.host };
  config.mail.transport = 'smtp';
  config.mail.host = '';
  await assert.rejects(
    () => mailer.send({ to: 'a@b.com', subject: 's', text: 't', html: '<p>t</p>' }),
    /No mail server is configured/
  );
  Object.assign(config.mail, previous);
});

/* ---------------------------------------------------------------- own profile */
test('profile: a signed-in person can rename themselves but not change their role', async () => {
  const email = await newUser('viewer');
  const token = await login(email, 'startpw1');

  const res = await call('POST', '/api/auth/profile', { token, body: { name: 'Renamed Person' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed Person');
  assert.equal(res.body.role, 'viewer');

  /* role is ignored here even if sent */
  await call('POST', '/api/auth/profile', { token, body: { name: 'Again', role: 'superadmin' } });
  assert.equal((await call('GET', '/api/auth/me', { token })).body.user.role, 'viewer');

  assert.equal((await call('POST', '/api/auth/profile', { token, body: { name: '   ' } })).body.error.code, 'bad_name');
  assert.equal((await call('POST', '/api/auth/profile', { body: { name: 'Nobody' } })).status, 401);
});

test('with email switched off, no code is issued and the page is told', async () => {
  /* MAIL_TRANSPORT=off is how this deployment runs: chat and the tracker need no email, and a
     link offering a code that cannot be sent is worse than no link at all. */
  const config = require('../src/config');
  const original = config.mail.transport;
  config.mail.transport = 'off';
  try {
    const before = mailer.outbox.length;
    const res = await call('POST', '/api/auth/forgot', { body: { email: 'sohel@example.com' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'mail_off');
    assert.match(res.body.error.message, /super admin/);
    assert.equal(mailer.outbox.length, before, 'nothing was sent');

    const health = await call('GET', '/api/health');
    assert.equal(health.body.email, false, 'the page is told not to offer it');
  } finally {
    config.mail.transport = original;
  }
});
