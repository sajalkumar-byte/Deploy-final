'use strict';
/* routes/items.js – projects, recurring items and tasks.

   Reading is open to every signed-in role. Writing is checked against the role matrix on every
   call, including the type being written, which is what limits a Superuser to Tasks:
     permissions.assert(role, 'write', type)
   For an edit we check the type of the item ALREADY in the database, so nobody can smuggle a
   project through by sending type:'Task' in the body. */

const items = require('../../model/items');
const audit = require('../../model/audit');
const permissions = require('../../model/permissions');
const { readJson, sendJson, clientIp, badRequest, notFound } = require('../../view/http');
const { requireUser } = require('../middleware');

function register(router) {
  /* ---- GET /api/items?type=&status=&person=&q= ---- */
  router.get('/api/items', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const q = ctx.query;
    const list = await items.list({
      type: q.get('type') || '',
      status: q.get('status') || '',
      person: q.get('person') || '',
      q: q.get('q') || '',
    });
    sendJson(res, 200, { items: list, count: list.length, role: me.role });
  });

  /* ---- GET /api/items/archive – read-only older tasks ---- */
  router.get('/api/items/archive', async (req, res, ctx) => {
    requireUser(ctx);
    sendJson(res, 200, { batches: await items.listArchive() });
  });

  /* ---- PUT /api/items/archive/:id – replace an archive batch (admins and above) ---- */
  router.put('/api/items/archive/:id', async (req, res, ctx) => {
    const me = requireUser(ctx);
    permissions.assert(me.role, 'write', 'Project');     // archive upload is an admin-level action
    const body = await readJson(req);
    const saved = await items.putArchive(req.params.id, body.rows);
    await audit.log({ actor: me.email, role: me.role, action: 'archive.put', target: saved.id,
                detail: { rows: saved.rows.length }, ip: clientIp(req) });
    sendJson(res, 200, saved);
  });

  /* ---- GET /api/items/:id ---- */
  router.get('/api/items/:id', async (req, res, ctx) => {
    requireUser(ctx);
    const item = await items.byId(req.params.id);
    if (!item) throw notFound('That item no longer exists');
    sendJson(res, 200, item);
  });

  /* ---- POST /api/items – create ---- */
  router.post('/api/items', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const body = await readJson(req);
    const type = String(body.type || '');
    if (!permissions.TYPES.includes(type)) {
      throw badRequest(`Type must be one of: ${permissions.TYPES.join(', ')}`, 'bad_type');
    }
    permissions.assert(me.role, 'write', type);          // Superuser: Task only
    const created = await items.create(body, me.email, me.role);
    await audit.log({ actor: me.email, role: me.role, action: 'item.create', target: created.id,
                detail: { type: created.type, title: created.title }, ip: clientIp(req) });
    sendJson(res, 201, created);
  });

  /* ---- PUT /api/items/:id – create or replace (what the browser's `set` does) ---- */
  router.put('/api/items/:id', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const body = await readJson(req);
    const existing = await items.byId(req.params.id);
    const type = existing ? existing.type : String(body.type || '');
    if (!permissions.TYPES.includes(type)) {
      throw badRequest(`Type must be one of: ${permissions.TYPES.join(', ')}`, 'bad_type');
    }
    permissions.assert(me.role, 'write', type);
    const saved = await items.put(req.params.id, body, me.email);
    await audit.log({ actor: me.email, role: me.role, action: existing ? 'item.update' : 'item.create',
                target: saved.id, detail: { type: saved.type, title: saved.title }, ip: clientIp(req) });
    sendJson(res, existing ? 200 : 201, saved);
  });

  /* ---- PATCH /api/items/:id – partial edit, including a status change ---- */
  router.patch('/api/items/:id', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const existing = await items.byId(req.params.id);
    if (!existing) throw notFound('That item no longer exists');
    permissions.assert(me.role, 'write', existing.type); // the stored type decides, not the body
    const body = await readJson(req);
    const saved = await items.update(existing.id, body, me.email);
    const changed = Object.keys(body).filter(k => k !== 'type');
    await audit.log({ actor: me.email, role: me.role, action: 'item.update', target: saved.id,
                detail: { fields: changed, status: saved.s }, ip: clientIp(req) });
    sendJson(res, 200, saved);
  });

  /* ---- DELETE /api/items/:id ---- */
  router.delete('/api/items/:id', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const existing = await items.byId(req.params.id);
    if (!existing) throw notFound('That item no longer exists');
    permissions.assert(me.role, 'write', existing.type);
    await items.remove(existing.id);
    await audit.log({ actor: me.email, role: me.role, action: 'item.delete', target: existing.id,
                detail: { type: existing.type, title: existing.title }, ip: clientIp(req) });
    sendJson(res, 200, { ok: true, id: existing.id });
  });
}

module.exports = { register };
