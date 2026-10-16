'use strict';
/* store/index.js – chooses where the data lives and hands the rest of the server one object.

   STORAGE=sqlite  (default)  a single file, nothing to set up
   STORAGE=sheets             a Google Spreadsheet, through a service account

   Vercel Blob was measured and rejected: it is object storage behind a cache, so a read can
   return a previous version and two writes a second apart silently overwrote each other. A
   tracker cannot lose an edit, so it is not offered.

   Every repository talks to this and nothing else, so the two drivers cannot drift apart. */

const config = require('../../config');

let store = null;

/* Each driver is required only when it is chosen, so a deployment never loads a module it
   cannot use – node:sqlite does not exist on every runtime, and @vercel/blob is optional. */
function build() {
  if (config.storage === 'sheets') {
    const { SheetsStore } = require('./sheets');
    return new SheetsStore({
      spreadsheetId: config.sheets.spreadsheetId,
      credentials: SheetsStore.readCredentials(config.sheets.credentials),
      apiBase: config.sheets.apiBase,
      tokenUrl: config.sheets.tokenUrl,
      cacheMs: config.sheets.cacheMs,
    });
  }
  const { SqliteStore } = require('./sqlite');
  return new SqliteStore(config.dbFile);
}

/** Open the storage once and create any missing tables or tabs. */
async function init(log = () => {}) {
  if (store) return store;
  /* Only keep the driver once it has really opened. Holding on to a half-open one made a later
     call look successful and then fail somewhere confusing. */
  const candidate = build();
  await candidate.init();
  store = candidate;
  log(`storage: ${store.describe()}`);
  return store;
}

function get() {
  if (!store) throw new Error('Storage is not open yet – call store.init() first');
  return store;
}

async function close() {
  if (store) { await store.close(); store = null; }
}

/** Replace the driver – used by the tests to run the same suite against both. */
function use(replacement) { store = replacement; return store; }

const nowIso = () => new Date().toISOString();

module.exports = { init, get, close, use, build, nowIso };
