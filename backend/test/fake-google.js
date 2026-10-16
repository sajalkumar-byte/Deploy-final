'use strict';
/* fake-google.js – a stand-in for Google's OAuth token endpoint and the Sheets REST API,
   so the Google Sheets storage driver can be tested properly without a Google account.

   It is deliberately strict: the token endpoint verifies the JWT signature with the service
   account's public key, so the signing code is genuinely exercised rather than skipped. */

const http = require('node:http');
const crypto = require('node:crypto');

const base64urlDecode = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Parse "Tab!A2:Z" into {tab, startRow, startCol, endRow, endCol} (1-based, inclusive). */
function parseRange(range) {
  const bang = range.lastIndexOf('!');
  const tab = bang === -1 ? '' : range.slice(0, bang).replace(/^'|'$/g, '');
  const cells = bang === -1 ? range : range.slice(bang + 1);
  const [from, to] = cells.split(':');
  const cell = text => {
    const m = /^([A-Z]*)(\d*)$/.exec(text || '');
    return { col: m && m[1] ? m[1].charCodeAt(0) - 64 : null, row: m && m[2] ? Number(m[2]) : null };
  };
  const a = cell(from);
  const b = to ? cell(to) : a;
  return {
    tab,
    startRow: a.row || 1, startCol: a.col || 1,
    endRow: b.row || Infinity, endCol: b.col || 26,
  };
}

function createFakeGoogle({ spreadsheetId = 'test-sheet', publicKey } = {}) {
  /* tab name -> {sheetId, rows: [[cell,...], ...]} */
  const tabs = new Map();
  let nextSheetId = 100;
  const calls = [];

  const ensureTab = title => {
    if (!tabs.has(title)) tabs.set(title, { sheetId: nextSheetId++, rows: [] });
    return tabs.get(title);
  };

  const readJson = req => new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });

  const send = (res, status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    calls.push(`${req.method} ${url.pathname}`);

    /* ---- OAuth token endpoint ---- */
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', c => { body += c; });
      await new Promise(r => req.on('end', r));
      const params = new URLSearchParams(body);
      const assertion = params.get('assertion') || '';
      const [header, claim, signature] = assertion.split('.');
      if (!header || !claim || !signature) return send(res, 400, { error: 'invalid_request' });

      const ok = crypto.createVerify('RSA-SHA256')
        .update(`${header}.${claim}`)
        .verify(publicKey, base64urlDecode(signature));
      if (!ok) return send(res, 400, { error: 'invalid_grant', error_description: 'bad signature' });

      const parsed = JSON.parse(base64urlDecode(claim).toString('utf8'));
      if (parsed.scope !== 'https://www.googleapis.com/auth/spreadsheets') {
        return send(res, 400, { error: 'invalid_scope' });
      }
      return send(res, 200, { access_token: 'fake-token-' + Date.now(), expires_in: 3600, token_type: 'Bearer' });
    }

    /* ---- everything below needs the bearer token ---- */
    if (!/^Bearer fake-token-/.test(req.headers.authorization || '')) {
      return send(res, 401, { error: { message: 'Missing or invalid credentials' } });
    }

    const prefix = `/v4/spreadsheets/${spreadsheetId}`;
    if (!url.pathname.startsWith(`/v4/spreadsheets/`)) return send(res, 404, { error: { message: 'Not found' } });
    if (!url.pathname.startsWith(prefix)) return send(res, 404, { error: { message: 'Requested entity was not found.' } });

    let rest = url.pathname.slice(prefix.length);

    /* metadata */
    if (rest === '' && req.method === 'GET') {
      return send(res, 200, {
        spreadsheetId,
        sheets: [...tabs.entries()].map(([title, t]) => ({ properties: { title, sheetId: t.sheetId } })),
      });
    }

    /* batchUpdate: addSheet and deleteDimension */
    if (rest === ':batchUpdate' && req.method === 'POST') {
      const body = await readJson(req);
      const replies = [];
      for (const request of body.requests || []) {
        if (request.addSheet) {
          const title = request.addSheet.properties.title;
          const tab = ensureTab(title);
          replies.push({ addSheet: { properties: { title, sheetId: tab.sheetId } } });
        } else if (request.deleteDimension) {
          const { range } = request.deleteDimension;
          const entry = [...tabs.values()].find(t => t.sheetId === range.sheetId);
          if (entry) entry.rows.splice(range.startIndex, range.endIndex - range.startIndex);
          replies.push({});
        } else {
          replies.push({});
        }
      }
      return send(res, 200, { spreadsheetId, replies });
    }

    /* values */
    if (rest.startsWith('/values/')) {
      const rawRange = decodeURIComponent(rest.slice('/values/'.length));
      const isAppend = rawRange.endsWith(':append');
      const range = parseRange(isAppend ? rawRange.slice(0, -':append'.length) : rawRange);
      const tab = ensureTab(range.tab);

      if (req.method === 'GET') {
        const out = [];
        for (let r = range.startRow; r <= Math.min(range.endRow, tab.rows.length); r++) {
          const line = tab.rows[r - 1] || [];
          out.push(line.slice(range.startCol - 1, range.endCol));
        }
        /* Google trims trailing empty rows */
        while (out.length && (!out[out.length - 1] || !out[out.length - 1].some(v => String(v ?? '').length))) out.pop();
        return send(res, 200, { range: rawRange, values: out });
      }

      if (req.method === 'POST' && isAppend) {
        const body = await readJson(req);
        let last = tab.rows.length;
        while (last > 0 && (!tab.rows[last - 1] || !tab.rows[last - 1].some(v => String(v ?? '').length))) last -= 1;
        (body.values || []).forEach((line, i) => { tab.rows[last + i] = line.map(v => String(v ?? '')); });
        return send(res, 200, { spreadsheetId, updates: { updatedRows: (body.values || []).length } });
      }

      if (req.method === 'PUT') {
        const body = await readJson(req);
        (body.values || []).forEach((line, i) => {
          const rowIndex = range.startRow - 1 + i;
          const row = tab.rows[rowIndex] || [];
          line.forEach((v, c) => { row[range.startCol - 1 + c] = String(v ?? ''); });
          tab.rows[rowIndex] = row;
        });
        return send(res, 200, { spreadsheetId, updatedRows: (body.values || []).length });
      }
    }

    return send(res, 404, { error: { message: `No fake handler for ${req.method} ${url.pathname}` } });
  });

  return {
    server,
    tabs,
    calls,
    /** Read a tab back as objects, the way a person looking at the sheet would see it. */
    rowsOf(title) {
      const tab = tabs.get(title);
      if (!tab || !tab.rows.length) return [];
      const header = tab.rows[0] || [];
      return tab.rows.slice(1)
        .filter(line => line && line.some(v => String(v ?? '').length))
        .map(line => Object.fromEntries(header.map((h, i) => [h, line[i] === undefined ? '' : line[i]])));
    },
    listen() {
      return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() { return new Promise(resolve => server.close(resolve)); },
  };
}

/** A throwaway service account, so the signing path is real. */
function makeServiceAccount() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKey,
    credentials: {
      type: 'service_account',
      client_email: 'tracker@test-project.iam.gserviceaccount.com',
      private_key: privateKey,
    },
  };
}

module.exports = { createFakeGoogle, makeServiceAccount, parseRange };
