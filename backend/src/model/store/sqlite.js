'use strict';
/* store/sqlite.js – keeps the data in a single SQLite file using Node's built-in engine.
   Fast, needs nothing installed, and is the default. The Google Sheets driver next to this one
   offers the same calls, so the rest of the server cannot tell them apart. */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { TABLES, TABLE_NAMES, normalizeRow } = require('../schema');

class SqliteStore {
  constructor(file) {
    this.kind = 'sqlite';
    this.file = file;
    this.db = null;
  }

  describe() { return `SQLite file ${this.file}`; }

  async init() {
    if (this.db) return this;
    if (this.file !== ':memory:') {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    for (const table of TABLE_NAMES) {
      const columns = TABLES[table].columns.map(c => `"${c}" TEXT NOT NULL DEFAULT ''`).join(', ');
      /* rowid gives the audit table a natural order without a key column of its own. */
      this.db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${columns});`);
      const key = TABLES[table].key;
      if (key) this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "${table}_key" ON "${table}" ("${key}");`);
    }
    return this;
  }

  /** Everything in a table, oldest first. */
  async all(table) {
    const rows = this.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    return rows.map(r => normalizeRow(table, r));
  }

  async filter(table, where = {}) {
    const keys = Object.keys(where);
    if (!keys.length) return this.all(table);
    const clause = keys.map(k => `"${k}" = ?`).join(' AND ');
    const rows = this.db.prepare(`SELECT * FROM "${table}" WHERE ${clause} ORDER BY rowid`)
      .all(...keys.map(k => String(where[k])));
    return rows.map(r => normalizeRow(table, r));
  }

  async find(table, where) {
    const rows = await this.filter(table, where);
    return rows.length ? rows[0] : null;
  }

  async insert(table, row) {
    const record = normalizeRow(table, row);
    const columns = TABLES[table].columns;
    this.db.prepare(
      `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...columns.map(c => String(record[c])));
    return record;
  }

  async update(table, where, patch) {
    const keys = Object.keys(where);
    const sets = Object.keys(patch);
    if (!sets.length) return 0;
    const res = this.db.prepare(
      `UPDATE "${table}" SET ${sets.map(c => `"${c}" = ?`).join(', ')}
       WHERE ${keys.map(k => `"${k}" = ?`).join(' AND ')}`
    ).run(...sets.map(c => String(patch[c] ?? '')), ...keys.map(k => String(where[k])));
    return Number(res.changes || 0);
  }

  async remove(table, where) {
    const keys = Object.keys(where);
    if (!keys.length) return 0;
    const res = this.db.prepare(
      `DELETE FROM "${table}" WHERE ${keys.map(k => `"${k}" = ?`).join(' AND ')}`
    ).run(...keys.map(k => String(where[k])));
    return Number(res.changes || 0);
  }

  /** Delete rows whose column compares less than or equal to a value – used to expire things. */
  async removeWhereLessOrEqual(table, column, value) {
    const res = this.db.prepare(`DELETE FROM "${table}" WHERE "${column}" <> '' AND "${column}" <= ?`)
      .run(String(value));
    return Number(res.changes || 0);
  }

  async count(table, where = {}) {
    return (await this.filter(table, where)).length;
  }

  async close() {
    if (this.db) { try { this.db.close(); } catch { /* already closed */ } this.db = null; }
  }
}

module.exports = { SqliteStore };
