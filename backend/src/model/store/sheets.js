'use strict';
/* store/sheets.js – keeps every row in a Google Spreadsheet, straight from Node.

   The server talks to the Google Sheets REST API using a service account. Signing the token
   needs nothing but Node's own crypto, so there is still no npm install:

     1. build a JWT, sign it with the service account's private key (RS256)
     2. swap it at Google's token endpoint for an access token (cached until it expires)
     3. call https://sheets.googleapis.com/v4/spreadsheets/<id>/...

   Setting it up:
     · Google Cloud console → create a service account → add a JSON key.
     · Enable the "Google Sheets API" for that project.
     · Share the spreadsheet with the service account's client_email, as Editor.
     · Point the server at it:
         STORAGE=sheets
         GOOGLE_SHEET_ID=14Z6wY6u...
         GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json     (a path, or the JSON itself)

   One tab per table, with the column names as the header row, so the data stays readable and
   you can sort, filter and chart it like any other sheet.
*/

const fs = require('node:fs');
const crypto = require('node:crypto');
const { TABLES, TABLE_NAMES, sheetName, normalizeRow } = require('../schema');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const LAST_COLUMN = 'Z';                 // no table here has more than 26 columns

const base64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Column letter for a zero-based index: 0 -> A, 25 -> Z. */
const columnLetter = index => String.fromCharCode(65 + index);

class SheetsStore {
  constructor(options = {}) {
    this.kind = 'sheets';
    this.spreadsheetId = options.spreadsheetId;
    this.credentials = options.credentials;          // {client_email, private_key, token_uri?}
    this.apiBase = (options.apiBase || 'https://sheets.googleapis.com').replace(/\/+$/, '');
    this.tokenUrl = options.tokenUrl || (this.credentials && this.credentials.token_uri)
      || 'https://oauth2.googleapis.com/token';
    this.cacheMs = options.cacheMs === undefined ? 1500 : options.cacheMs;

    this.token = null;                 // {value, expiresAt}
    this.tabs = null;                  // tab name -> numeric sheet id
    this.cache = new Map();            // table -> {rows, at}
    this.queue = Promise.resolve();    // writes run one after another
  }

  describe() {
    const who = this.credentials ? this.credentials.client_email : 'no service account';
    return `Google Sheet ${this.spreadsheetId || '(no id)'} as ${who}`;
  }

  /* ---------------------------------------------------------------- credentials */
  static readCredentials(source) {
    if (!source) return null;
    let text = String(source).trim();
    if (!text.startsWith('{')) {
      if (!fs.existsSync(text)) throw new Error(`Service account file not found: ${text}`);
      text = fs.readFileSync(text, 'utf8');
    }
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('The service account JSON could not be parsed'); }
    if (!json.client_email || !json.private_key) {
      throw new Error('The service account JSON needs client_email and private_key');
    }
    return json;
  }

  async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64url(JSON.stringify({
      iss: this.credentials.client_email,
      scope: SCOPE,
      aud: this.tokenUrl,
      iat: now,
      exp: now + 3600,
    }));
    const signature = base64url(
      crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(this.credentials.private_key)
    );

    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claim}.${signature}`,
      }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`Google refused the service account: ${body.error_description || body.error || res.status}`);
    }
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (Number(body.expires_in || 3600) * 1000),
    };
    return this.token.value;
  }

  /* ---------------------------------------------------------------- the API */
  async api(method, path, body) {
    const token = await this.accessToken();
    const res = await fetch(`${this.apiBase}/v4/spreadsheets/${this.spreadsheetId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const message = (json && json.error && json.error.message) || text || String(res.status);
      const err = new Error(`Google Sheets: ${message}`);
      err.status = res.status;
      throw err;
    }
    return json || {};
  }

  /* ---------------------------------------------------------------- setup */
  async init() {
    if (!this.credentials) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set – paste the service account JSON key');
    }
    if (!this.spreadsheetId) {
      throw new Error('GOOGLE_SHEET_ID is not set – the id in the spreadsheet URL');
    }

    const meta = await this.api('GET', '?fields=sheets.properties');
    this.tabs = {};
    for (const sheet of meta.sheets || []) {
      this.tabs[sheet.properties.title] = sheet.properties.sheetId;
    }

    /* Create any tab that is missing, then write its header row. */
    const missing = TABLE_NAMES.filter(t => this.tabs[sheetName(t)] === undefined);
    if (missing.length) {
      const result = await this.api('POST', ':batchUpdate', {
        requests: missing.map(t => ({ addSheet: { properties: { title: sheetName(t) } } })),
      });
      for (const reply of result.replies || []) {
        if (reply.addSheet) this.tabs[reply.addSheet.properties.title] = reply.addSheet.properties.sheetId;
      }
    }
    for (const table of TABLE_NAMES) {
      const header = await this.readValues(table, `A1:${LAST_COLUMN}1`);
      if (!header.length || !header[0] || !header[0].length) {
        await this.writeValues(table, `A1`, [TABLES[table].columns]);
      }
    }
    return this;
  }

  tabId(table) {
    const id = this.tabs && this.tabs[sheetName(table)];
    if (id === undefined) throw new Error(`The sheet tab "${sheetName(table)}" is missing – restart the server`);
    return id;
  }

  async readValues(table, range) {
    const encoded = encodeURIComponent(`${sheetName(table)}!${range}`);
    const data = await this.api('GET', `/values/${encoded}`);
    return data.values || [];
  }

  async writeValues(table, cell, values) {
    const encoded = encodeURIComponent(`${sheetName(table)}!${cell}`);
    return this.api('PUT', `/values/${encoded}?valueInputOption=RAW`, { values });
  }

  /* ---------------------------------------------------------------- rows */
  /** Read a whole tab into objects. Row numbers are kept so a row can be edited in place. */
  async load(table, { fresh = false } = {}) {
    const cached = this.cache.get(table);
    if (!fresh && cached && Date.now() - cached.at < this.cacheMs) return cached.rows;

    const values = await this.readValues(table, `A2:${LAST_COLUMN}`);
    const columns = TABLES[table].columns;
    const rows = [];
    values.forEach((line, index) => {
      if (!line || !line.some(v => String(v === null || v === undefined ? '' : v).length)) return;
      const row = {};
      columns.forEach((column, i) => {
        const v = line[i];
        row[column] = v === undefined || v === null ? '' : String(v);
      });
      row.__row = index + 2;                 // the real spreadsheet row number
      rows.push(row);
    });
    this.cache.set(table, { rows, at: Date.now() });
    return rows;
  }

  invalidate(table) { this.cache.delete(table); }

  /** Writes are serialised, so two requests cannot land on the same spreadsheet row. */
  write(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  strip(table, row) { return normalizeRow(table, row); }

  matches(row, where) {
    return Object.keys(where).every(k => String(row[k] ?? '') === String(where[k] ?? ''));
  }

  async all(table) {
    return (await this.load(table)).map(r => this.strip(table, r));
  }

  async filter(table, where = {}) {
    const rows = await this.load(table);
    return rows.filter(r => this.matches(r, where)).map(r => this.strip(table, r));
  }

  async find(table, where) {
    const rows = await this.filter(table, where);
    return rows.length ? rows[0] : null;
  }

  async insert(table, row) {
    const record = normalizeRow(table, row);
    const line = TABLES[table].columns.map(c => String(record[c]));
    await this.write(async () => {
      const encoded = encodeURIComponent(`${sheetName(table)}!A1`);
      await this.api('POST',
        `/values/${encoded}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { values: [line] });
      this.invalidate(table);
    });
    return record;
  }

  async update(table, where, patch) {
    return this.write(async () => {
      const rows = await this.load(table, { fresh: true });
      const columns = TABLES[table].columns;
      const targets = rows.filter(r => this.matches(r, where));
      for (const row of targets) {
        const merged = { ...row, ...patch };
        const line = columns.map(c => String(merged[c] ?? ''));
        await this.writeValues(table, `A${row.__row}:${columnLetter(columns.length - 1)}${row.__row}`, [line]);
      }
      this.invalidate(table);
      return targets.length;
    });
  }

  async remove(table, where) {
    return this.write(async () => {
      const rows = await this.load(table, { fresh: true });
      const targets = rows.filter(r => this.matches(r, where));
      if (!targets.length) return 0;
      /* Delete from the bottom up so earlier row numbers stay valid. */
      const requests = targets
        .map(r => r.__row)
        .sort((a, b) => b - a)
        .map(rowNumber => ({
          deleteDimension: {
            range: { sheetId: this.tabId(table), dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber },
          },
        }));
      await this.api('POST', ':batchUpdate', { requests });
      this.invalidate(table);
      return targets.length;
    });
  }

  async removeWhereLessOrEqual(table, column, value) {
    return this.write(async () => {
      const rows = await this.load(table, { fresh: true });
      const targets = rows.filter(r => String(r[column] || '') && String(r[column]) <= String(value));
      if (!targets.length) return 0;
      const requests = targets
        .map(r => r.__row)
        .sort((a, b) => b - a)
        .map(rowNumber => ({
          deleteDimension: {
            range: { sheetId: this.tabId(table), dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber },
          },
        }));
      await this.api('POST', ':batchUpdate', { requests });
      this.invalidate(table);
      return targets.length;
    });
  }

  async count(table, where = {}) {
    return (await this.filter(table, where)).length;
  }

  async close() { this.cache.clear(); }
}

module.exports = { SheetsStore };
