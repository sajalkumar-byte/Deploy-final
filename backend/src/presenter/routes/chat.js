'use strict';
/* routes/chat.js – one-to-one chat over plain HTTP.

   The live side of chat is Socket.IO (see src/realtime.js); these endpoints are what the page
   uses to load a conversation, to send when the socket is not connected, and to catch up after
   being offline. Everything goes through the same storage, so a message is a row like any other.

   Chat is open to every signed-in role: a Viewer can read the tracker only, but can still talk
   to colleagues. */

const messages = require('../../model/messages');
const users = require('../../model/users');
const audit = require('../../model/audit');
const { readJson, sendJson, clientIp, badRequest, notFound } = require('../../view/http');
const { requireUser } = require('../middleware');

function register(router, realtime) {
  /* ---- GET /api/chat/contacts – everyone you can talk to, with unread counts ---- */
  router.get('/api/chat/contacts', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const people = await users.list();
    const contacts = await messages.summary(me.email, people);
    const online = realtime ? realtime.onlineEmails() : [];
    sendJson(res, 200, {
      me: { email: me.email, name: me.name, role: me.role },
      contacts: contacts.map(c => ({ ...c, online: online.includes(c.email) })),
      unread: contacts.reduce((sum, c) => sum + c.unread, 0),
      realtime: Boolean(realtime),
    });
  });

  /* ---- GET /api/chat/with/:email – the conversation, oldest first ---- */
  router.get('/api/chat/with/:email', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const other = await users.byEmail(req.params.email);
    if (!other) throw notFound('No colleague with that email');

    const list = await messages.between(me.email, other.email, {
      limit: ctx.query.get('limit') || 200,
      since: ctx.query.get('since') || '',
    });
    const marked = await messages.markRead(me.email, other.email);
    if (marked && realtime) realtime.notifyRead(other.email, me.email);

    sendJson(res, 200, {
      with: { email: other.email, name: other.name, role: other.role },
      messages: list,
      markedRead: marked,
    });
  });

  /* ---- POST /api/chat/with/:email – send a message ---- */
  router.post('/api/chat/with/:email', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const other = await users.byEmail(req.params.email);
    if (!other) throw notFound('No colleague with that email');

    const body = await readJson(req);
    const message = await messages.send({ from: me.email, to: other.email, body: body.body });
    if (realtime) realtime.deliver(message, { from: me, to: other });
    await audit.log({
      actor: me.email, role: me.role, action: 'chat.send', target: other.email,
      detail: `${String(message.body).length} characters`, ip: clientIp(req),
    });
    sendJson(res, 201, message);
  });

  /* ---- POST /api/chat/read/:email – mark their messages as read ---- */
  router.post('/api/chat/read/:email', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const other = await users.byEmail(req.params.email);
    if (!other) throw notFound('No colleague with that email');
    const marked = await messages.markRead(me.email, other.email);
    if (marked && realtime) realtime.notifyRead(other.email, me.email);
    sendJson(res, 200, { ok: true, marked });
  });

  /* ---- GET /api/chat/unread – one number for the badge on the Chat tab ---- */
  router.get('/api/chat/unread', async (req, res, ctx) => {
    const me = requireUser(ctx);
    sendJson(res, 200, { unread: await messages.unreadCount(me.email) });
  });
}

module.exports = { register };
