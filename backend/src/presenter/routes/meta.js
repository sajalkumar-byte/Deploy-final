'use strict';
/* routes/meta.js – health, dashboard figures, server-side export and the audit log.

   The export route is gated on the 'export' capability, so a Viewer gets 403 here exactly as the
   browser's PDF / Excel / Print buttons are hidden for them. */

const items = require('../../model/items');
const users = require('../../model/users');
const audit = require('../../model/audit');
const permissions = require('../../model/permissions');
const db = require('../../db');
const config = require('../../config');
const { sendJson, sendText, clientIp } = require('../../view/http');
const { requireUser } = require('../middleware');

const LABEL = { Project: 'Project', Drive: 'Recurring', Task: 'Task' };
const COLUMNS = ['ID', 'Type', 'Title', 'Status', 'Priority', 'Focal-1', 'Focal-2',
                 'Start', 'End', 'Stakeholder', 'Milestones / progress', 'Remarks'];

const rowOf = i => [i.id, LABEL[i.type] || i.type, i.title, i.s, i.pri, i.f1, i.f2,
                    i.sd, i.e, i.sh, String(i.ms || '').split(/\s*(?:\n|\*|•)\s*/).filter(Boolean).join('; '), i.rm];

function toCsv(rows) {
  const esc = v => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\r\n');
}

function register(router) {
  /* ---- GET /api/health – no sign-in needed, used by monitoring and by the browser to
          discover that a backend is present at all ---- */
  router.get('/api/health', async (req, res) => {
    sendJson(res, 200, {
      ok: true,
      service: 'task-tracker-server',
      version: require('../../../package.json').version,
      env: config.env,
      time: db.nowIso(),
      setupRequired: await users.count() === 0,
      roles: permissions.ROLES,
      /* So the page knows whether to offer "Forgot your password?" at all. */
      email: config.mail.enabled,
    });
  });

  /* ---- GET /api/stats – the numbers behind the dashboard ---- */
  router.get('/api/stats', async (req, res, ctx) => {
    requireUser(ctx);
    const stats = await items.stats();
    const all = await items.list();
    const workload = {};
    for (const i of all) {
      for (const who of [i.f1, i.f2]) {
        const name = String(who || '').replace(/\s*\(.*?\)/g, '').trim();
        if (!name) continue;
        workload[name] = workload[name] || { Ongoing: 0, 'On Hold': 0, Listed: 0, Closed: 0, Done: 0, total: 0 };
        if (workload[name][i.s] !== undefined) workload[name][i.s] += 1;
        workload[name].total += 1;
      }
    }
    sendJson(res, 200, { ...stats, workload, people: Object.keys(workload).sort() });
  });

  /* ---- GET /api/export?format=json|csv&type=&status= ---- */
  router.get('/api/export', async (req, res, ctx) => {
    const me = requireUser(ctx);
    permissions.assert(me.role, 'export');          // Viewer is refused here

    const q = ctx.query;
    const format = (q.get('format') || 'json').toLowerCase();
    const filter = {
      type: q.get('type') || '',
      status: q.get('status') || '',
      person: q.get('person') || '',
      q: q.get('q') || '',
    };
    const list = await items.list(filter);
    const day = new Date().toISOString().slice(0, 10);
    const name = `Tracker-${filter.type ? LABEL[filter.type] || filter.type : 'All'}${filter.status ? '-' + filter.status.replace(/\s+/g, '-') : ''}-${day}`;

    await audit.log({ actor: me.email, role: me.role, action: 'export', detail: { format, ...filter, rows: list.length }, ip: clientIp(req) });

    if (format === 'csv') {
      const csv = toCsv([COLUMNS, ...list.map(rowOf)]);
      return sendText(res, 200, '﻿' + csv, 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="${name}.csv"`,
      });
    }
    sendJson(res, 200, {
      title: 'Task and Project Tracker',
      filter, generatedAt: db.nowIso(), generatedBy: me.email,
      columns: COLUMNS, rows: list.map(rowOf), items: list, stats: await items.stats(),
    });
  });

  /* ---- GET /api/audit – super admin only ---- */
  router.get('/api/audit', async (req, res, ctx) => {
    const me = requireUser(ctx);
    permissions.assert(me.role, 'viewAudit');
    const q = ctx.query;
    sendJson(res, 200, {
      entries: await audit.list({
        limit: q.get('limit') || 200,
        offset: q.get('offset') || 0,
        action: q.get('action') || '',
        actor: q.get('actor') || '',
      }),
      total: await audit.count(),
    });
  });

  /* ---- GET /api/roles – the role matrix, so the browser and the API never disagree ---- */
  router.get('/api/roles', async (req, res) => {
    sendJson(res, 200, { roles: permissions.ROLES.map(r => permissions.describe(r)) });
  });
}

module.exports = { register, toCsv, COLUMNS, rowOf };
