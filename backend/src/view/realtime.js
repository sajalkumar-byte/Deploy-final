'use strict';
/* realtime.js – the live half of chat, over Socket.IO (WebSocket, falling back to long polling
   on networks that block it).

   A socket must prove who it is with the same session token the REST API uses, so chat cannot be
   joined by anyone who is not signed in. Each person gets a private room named after their email,
   which makes delivering a one-to-one message a single emit to two rooms: the recipient's and
   the sender's, so the sender's other tabs stay in step too.

   Events the browser may send:
     chat:send     {to, body}            -> stores the message and delivers it
     chat:read     {from}                -> marks their messages read and tells them
     chat:typing   {to, typing}          -> passed straight through, never stored
   Events the browser receives:
     chat:message  the message object
     chat:read     {by}       your messages to that person have been read
     chat:typing   {from, typing}
     presence      {online: [...emails]}
*/

const sessions = require('../model/sessions');
const users = require('../model/users');
const messages = require('../model/messages');
const audit = require('../model/audit');

const room = email => `user:${String(email).toLowerCase()}`;

function attach(httpServer, { path = '/socket.io', log = () => {} } = {}) {
  let Server;
  try {
    ({ Server } = require('socket.io'));
  } catch (err) {
    log('socket.io is not installed – chat will fall back to plain requests');
    return null;
  }

  const io = new Server(httpServer, {
    path,
    serveClient: true,                 // the browser loads the client from /socket.io/socket.io.js
    cors: { origin: true, credentials: true },
    pingTimeout: 25000,
  });

  /** email -> number of open sockets, so presence survives several tabs. */
  const online = new Map();

  const setOnline = (email, delta) => {
    const key = String(email).toLowerCase();
    const next = (online.get(key) || 0) + delta;
    if (next > 0) online.set(key, next); else online.delete(key);
    io.emit('presence', { online: [...online.keys()] });
  };

  /* ---------- who is on the other end ---------- */
  io.use(async (socket, next) => {
    try {
      const handshake = socket.handshake || {};
      /* The page may hold a bearer token, or only the session cookie after a reload. */
      const cookies = {};
      for (const part of String((handshake.headers && handshake.headers.cookie) || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 1) continue;
        try { cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { /* skip */ }
      }
      const token =
        (handshake.auth && handshake.auth.token) ||
        (handshake.query && handshake.query.token) ||
        cookies[require('../config').sessionCookie] ||
        '';
      const session = await sessions.find(token);
      if (!session) return next(new Error('Please sign in first'));
      const user = await users.byEmail(session.email);
      if (!user) return next(new Error('That account no longer exists'));
      socket.data.user = { email: user.email, name: user.name, role: user.role };
      return next();
    } catch (err) {
      return next(new Error('Could not check your sign-in'));
    }
  });

  io.on('connection', socket => {
    const me = socket.data.user;
    socket.join(room(me.email));
    setOnline(me.email, +1);
    socket.emit('presence', { online: [...online.keys()] });

    socket.on('chat:send', async (payload, ack) => {
      try {
        const to = String((payload && payload.to) || '').toLowerCase();
        const other = await users.byEmail(to);
        if (!other) throw new Error('No colleague with that email');

        const message = await messages.send({ from: me.email, to: other.email, body: payload && payload.body });
        io.to(room(other.email)).to(room(me.email)).emit('chat:message', message);
        await audit.log({
          actor: me.email, role: me.role, action: 'chat.send', target: other.email,
          detail: `${String(message.body).length} characters (socket)`,
        });
        if (typeof ack === 'function') ack({ ok: true, message });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message || 'Could not send' });
      }
    });

    socket.on('chat:read', async (payload, ack) => {
      try {
        const from = String((payload && payload.from) || '').toLowerCase();
        const marked = await messages.markRead(me.email, from);
        if (marked) io.to(room(from)).emit('chat:read', { by: me.email });
        if (typeof ack === 'function') ack({ ok: true, marked });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    /* Typing is a hint, not data: it is never stored. */
    socket.on('chat:typing', payload => {
      const to = String((payload && payload.to) || '').toLowerCase();
      if (!to) return;
      io.to(room(to)).emit('chat:typing', { from: me.email, typing: Boolean(payload && payload.typing) });
    });

    socket.on('disconnect', () => setOnline(me.email, -1));
  });

  log(`chat: Socket.IO listening on ${path}`);

  return {
    io,
    onlineEmails: () => [...online.keys()],
    /** Push a message that arrived over HTTP to whoever has a socket open. */
    deliver(message) {
      io.to(room(message.to)).to(room(message.from)).emit('chat:message', message);
    },
    notifyRead(toEmail, byEmail) {
      io.to(room(toEmail)).emit('chat:read', { by: byEmail });
    },
    close() { return new Promise(resolve => io.close(resolve)); },
  };
}

module.exports = { attach, room };
