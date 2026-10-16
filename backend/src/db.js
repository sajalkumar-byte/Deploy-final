'use strict';
/* db.js – kept as a thin name for the storage layer, so older imports keep working.
   The real work is in src/store/, which can be a SQLite file or a Google Spreadsheet. */

const store = require('./model/store');
const sessions = require('./model/sessions');

module.exports = {
  init: store.init,
  get: store.get,
  close: store.close,
  nowIso: store.nowIso,
  purgeExpiredSessions: () => sessions.purgeExpired(),
};
