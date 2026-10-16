/* The whole API as one Vercel function.

   Vercel sends every /api/* request here, and the same request handler the standalone server
   uses answers it. Storage is opened once per warm instance and reused.

   Chat still works here, but over polling rather than a socket: Vercel's functions are
   short-lived, so nothing can hold a WebSocket open. The browser notices and falls back. */

const store = require('../backend/src/model/store');
const { createHandler } = require('../backend/src/presenter/app');
const { ensureSeedAccounts } = require('../backend/src/model/seed');

let ready = null;
const handler = createHandler(null);        // null: no live socket in a serverless function

module.exports = async function (req, res) {
  try {
    if (!ready) {
      /* A failed start must not be remembered, or every later request repeats the same error
         without ever trying again. */
      const attempt = (async () => {
        await store.init();
        await ensureSeedAccounts(msg => console.log(`[setup] ${msg}`));
      })();
      ready = attempt;
      attempt.catch(() => { if (ready === attempt) ready = null; });
    }
    await ready;
    return handler(req, res);
  } catch (err) {
    console.error('[startup]', err);
    const storage = (process.env.STORAGE || 'sqlite').toLowerCase();
    /* Answer the health check anyway: it is the one call people use to find out what is wrong. */
    const body = (req.url || '').startsWith('/api/health')
      ? {
          ok: false,
          service: 'task-tracker-server',
          storage,
          storageReady: false,
          problem: String(err && err.message || err),
          hint: storage === 'sheets'
            ? 'Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON, and share the spreadsheet with the service account as Editor.'
            : 'A serverless deployment has no disk that survives a request. Set STORAGE=sheets and supply a service account.',
        }
      : { error: { code: 'storage_unavailable', message: 'The backend has no storage configured yet' } };
    res.statusCode = (req.url || '').startsWith('/api/health') ? 200 : 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  }
};
