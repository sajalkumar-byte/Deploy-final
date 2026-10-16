'use strict';
/* config.js – every setting in one place, read from the environment with safe defaults.
   Copy .env.example to .env and edit it, or set real environment variables in production. */

const fs = require('node:fs');
const path = require('node:path');

/* Minimal .env reader – avoids a dependency. Lines of the form KEY=value, # starts a comment. */
function loadDotEnv(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const ROOT = path.resolve(__dirname, '..');        // server/
const PROJECT = path.resolve(ROOT, '..');          // repository root (the frontend lives here)

loadDotEnv(path.join(ROOT, '.env'));

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: num(process.env.PORT, 3000),

  /* Where the data lives: 'sqlite' (a local file) or 'sheets' (a Google Spreadsheet). */
  storage: (process.env.STORAGE || 'sqlite').toLowerCase(),

  /* Used when storage is 'sqlite'. ':memory:' is used by the tests. */
  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'tracker.db'),

  /* Used when storage is 'sheets'. The service account must be an Editor on the spreadsheet. */
  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEET_ID || '',
    credentials: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    apiBase: process.env.GOOGLE_SHEETS_API || 'https://sheets.googleapis.com',
    tokenUrl: process.env.GOOGLE_TOKEN_URL || '',
    cacheMs: num(process.env.GOOGLE_SHEETS_CACHE_MS, 1500),
  },

  /* Serve the existing frontend (index.html, js/, css/, vendor/, assets/, config/) from the same
     origin, so the browser needs no CORS and cookies work normally. */
  serveStatic: bool(process.env.SERVE_STATIC, true),
  staticDir: process.env.STATIC_DIR || PROJECT,

  /* Extra origins allowed to call the API (only needed when the frontend is hosted elsewhere,
     for example on GitHub Pages or Vercel). Comma separated, exact origins. */
  corsOrigins: String(process.env.CORS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  /* Sessions */
  sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 12),
  sessionCookie: 'tracker_session',
  csrfCookie: 'tracker_csrf',
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),

  /* Sign-in throttling: max failed attempts per email+IP inside the window. */
  loginMaxAttempts: num(process.env.LOGIN_MAX_ATTEMPTS, 8),
  loginWindowMs: num(process.env.LOGIN_WINDOW_MINUTES, 15) * 60 * 1000,

  /* General API rate limit per IP. */
  rateMax: num(process.env.RATE_MAX, 600),
  rateWindowMs: num(process.env.RATE_WINDOW_MINUTES, 1) * 60 * 1000,

  /* The super admin created on an empty database. Change the password after the first sign-in. */
  seedSuperAdmin: {
    email: (process.env.SEED_SUPERADMIN_EMAIL || 'admin@tracker.com').toLowerCase(),
    name: process.env.SEED_SUPERADMIN_NAME || 'Super admin',
    password: process.env.SEED_SUPERADMIN_PASSWORD || 'Admin@1234',
  },
  /* A second seeded account, kept because the static build ships with it. Set SEED_TEST_ADMIN=0 to skip. */
  seedTestAdmin: bool(process.env.SEED_TEST_ADMIN, true)
    ? {
        email: (process.env.SEED_TEST_ADMIN_EMAIL || 'testadmin@gmail.com').toLowerCase(),
        name: process.env.SEED_TEST_ADMIN_NAME || 'test admin',
        password: process.env.SEED_TEST_ADMIN_PASSWORD || 'testpass',
        role: 'admin',
      }
    : null,

  /* Sending the "forgot password" code. 'console' just logs it, which needs no account;
     'off' switches the whole feature out, and the page then stops offering it. */
  mail: {
    transport: (process.env.MAIL_TRANSPORT || 'console').toLowerCase(),
    host: process.env.MAIL_HOST || '',
    port: num(process.env.MAIL_PORT, 587),
    user: process.env.MAIL_USER || '',
    pass: process.env.MAIL_PASS || '',
    from: process.env.MAIL_FROM || process.env.MAIL_USER || 'tracker@localhost',
    fromName: process.env.MAIL_FROM_NAME || 'Task and Project Tracker',
    get enabled() { return this.transport !== 'off'; },
  },

  /* Forgotten-password codes */
  resetCodeMinutes: num(process.env.RESET_CODE_MINUTES, 15),
  resetMaxTries: num(process.env.RESET_MAX_TRIES, 5),
  resetMaxRequests: num(process.env.RESET_MAX_REQUESTS, 5),
  resetRequestWindowMs: num(process.env.RESET_REQUEST_WINDOW_MINUTES, 60) * 60 * 1000,

  bodyLimitBytes: num(process.env.BODY_LIMIT_BYTES, 512 * 1024),
  logRequests: bool(process.env.LOG_REQUESTS, true),

  paths: { ROOT, PROJECT },
};

module.exports = config;
