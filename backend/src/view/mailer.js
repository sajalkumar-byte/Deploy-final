'use strict';
/* mailer.js – sends the "forgot password" code by email.

   Three transports, chosen with MAIL_TRANSPORT:
     off      no email at all. The forgotten-password flow is refused and the page hides it.
     smtp     a real mail server. Works with any SMTP provider, including a free Gmail account
              with an App Password, Brevo, Mailjet, Zoho and so on. Uses Node's own net/tls,
              so there is still nothing to npm install.
     console  the default. The code is printed in the server log instead of being emailed.
              Fine for a local or intranet install where an administrator can read the log.
     memory   used by the tests; messages are kept in an array instead of being sent.

   SMTP settings: MAIL_HOST, MAIL_PORT (587 or 465), MAIL_USER, MAIL_PASS, MAIL_FROM.
*/

const net = require('node:net');
const tls = require('node:tls');
const config = require('../config');

const outbox = [];                       // only used by the memory transport

/* ---------- message building ---------- */

/** RFC 2047 encoding, so a subject with non-ASCII characters survives. */
function encodeHeader(value) {
  const text = String(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function wrapBase64(text) {
  return Buffer.from(String(text), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/** A multipart/alternative message, so both plain and rich mail readers show something sensible. */
function buildMessage({ from, fromName, to, subject, text, html }) {
  const boundary = '----tracker-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@tracker>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(html),
    `--${boundary}--`,
    '',
  ];
  return headers.join('\r\n') + '\r\n' + body.join('\r\n');
}

/* ---------- a very small SMTP client ---------- */

function smtpConversation(socket, steps, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error('The mail server did not answer in time'));
      socket.destroy();
    }, timeoutMs);

    socket.on('error', e => finish(e));
    socket.on('close', () => finish(new Error('The mail server closed the connection')));

    /** Wait for one complete reply (continuation lines start "250-"). */
    const expect = codes => new Promise((ok, fail) => {
      const onData = chunk => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (/^\d{3} /.test(line)) {
            const code = Number(line.slice(0, 3));
            buffer = '';
            socket.off('data', onData);
            if (codes.includes(code)) return ok({ code, line });
            return fail(new Error(`Mail server said: ${line}`));
          }
        }
      };
      socket.on('data', onData);
    });

    (async () => {
      try {
        const value = await steps({
          expect,
          send: line => socket.write(line + '\r\n'),
          raw: data => socket.write(data),
          socket,
        });
        finish(null, value);
      } catch (e) {
        finish(e);
        try { socket.destroy(); } catch { /* already gone */ }
      }
    })();
  });
}

async function sendSmtp(message, { host, port, user, pass, from, to, secure, timeoutMs = 20000 }) {
  const connect = () => new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.once('error', reject);
    socket.setTimeout(timeoutMs);
  });

  let socket = await connect();

  return smtpConversation(socket, async ctx => {
    await ctx.expect([220]);
    ctx.send(`EHLO ${host}`);
    let greeting = await ctx.expect([250]);

    /* On the submission port, upgrade the plain connection to TLS before authenticating. */
    if (!secure) {
      ctx.send('STARTTLS');
      await ctx.expect([220]);
      const upgraded = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: host }, () => resolve(s));
        s.once('error', reject);
      });
      socket = upgraded;
      return smtpConversation(upgraded, async inner => {
        inner.send(`EHLO ${host}`);
        await inner.expect([250]);
        await authenticateAndSend(inner, { user, pass, from, to, message });
        return true;
      }, timeoutMs);
    }

    await authenticateAndSend(ctx, { user, pass, from, to, message });
    return true;
  }, timeoutMs);
}

async function authenticateAndSend(ctx, { user, pass, from, to, message }) {
  if (user) {
    ctx.send('AUTH LOGIN');
    await ctx.expect([334]);
    ctx.send(Buffer.from(String(user), 'utf8').toString('base64'));
    await ctx.expect([334]);
    ctx.send(Buffer.from(String(pass), 'utf8').toString('base64'));
    await ctx.expect([235]);
  }
  ctx.send(`MAIL FROM:<${from}>`);
  await ctx.expect([250]);
  ctx.send(`RCPT TO:<${to}>`);
  await ctx.expect([250, 251]);
  ctx.send('DATA');
  await ctx.expect([354]);
  /* A line of a single dot would end the message early, so it is escaped. */
  ctx.raw(message.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
  await ctx.expect([250]);
  ctx.send('QUIT');
}

/* ---------- the public call ---------- */

/**
 * Send one message. Resolves {ok:true, transport} or throws with a readable reason.
 */
async function send({ to, subject, text, html }) {
  const transport = config.mail.transport;

  /* Switched off on purpose. Nothing is queued or half-sent: the caller is told at once, so it
     can say something true to the person waiting rather than promising a code that will not
     arrive. */
  if (transport === 'off') {
    const err = new Error('Email is switched off on this server');
    err.code = 'mail_off';
    throw err;
  }

  const from = config.mail.from;
  const fromName = config.mail.fromName;

  if (transport === 'memory') {
    outbox.push({ to, subject, text, html, at: new Date().toISOString() });
    return { ok: true, transport };
  }

  if (transport === 'console') {
    console.log('');
    console.log('──────── email (MAIL_TRANSPORT=console, nothing was sent) ────────');
    console.log(`  to:      ${to}`);
    console.log(`  subject: ${subject}`);
    console.log(text.split('\n').map(l => '  ' + l).join('\n'));
    console.log('──────────────────────────────────────────────────────────────────');
    console.log('');
    outbox.push({ to, subject, text, html, at: new Date().toISOString() });
    return { ok: true, transport };
  }

  const { host, port, user, pass } = config.mail;
  if (!host) throw new Error('No mail server is configured (set MAIL_HOST or MAIL_TRANSPORT=console)');

  const message = buildMessage({ from, fromName, to, subject, text, html });
  await sendSmtp(message, { host, port, user, pass, from, to, secure: port === 465 });
  return { ok: true, transport };
}

/** The reset email, in both plain and rich form. */
function resetEmail(name, code, minutes) {
  const subject = `Your Task and Project Tracker password code: ${code}`;
  const text = [
    `Hello ${name},`, '',
    `Your password reset code is: ${code}`, '',
    `Type it on the tracker sign-in page within ${minutes} minutes, together with`,
    'the new password you want to use.', '',
    'If you did not ask for this, ignore this email. Your current password still works.', '',
    'Infrastructure & Support, Technology, Microfinance',
  ].join('\n');
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a;line-height:1.6">'
    + `<p>Hello ${esc(name)},</p><p>Your password reset code is:</p>`
    + `<p style="font-size:30px;font-weight:bold;letter-spacing:8px;color:#ec008c;margin:18px 0">${code}</p>`
    + `<p>Type it on the tracker sign-in page within <b>${minutes} minutes</b>, together with the new password you want to use.</p>`
    + '<p style="color:#64748b;font-size:13px">If you did not ask for this, ignore this email. Your current password still works.</p>'
    + '<hr style="border:0;border-top:1px solid #e5e9f2;margin:18px 0">'
    + '<p style="color:#64748b;font-size:12px">Infrastructure &amp; Support · Technology · Microfinance</p></div>';
  return { subject, text, html };
}

module.exports = { send, resetEmail, buildMessage, outbox, encodeHeader };
