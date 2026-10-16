'use strict';
/* middleware.js – cross-cutting request handling: rate limiting, sign-in throttling,
   identifying the signed-in person, and CSRF protection for cookie-based requests. */

const config = require('../config');
const sessions = require('../model/sessions');
const users = require('../model/users');
const { unauthorized, forbidden, tooMany, parseCookies, clientIp } = require('../view/http');
const { safeEqual } = require('../model/crypto');

/* ---------- simple in-memory counters (one process; reset on restart) ---------- */
function createLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, Math.max(windowMs, 30_000)).unref?.();

  return {
    /** Returns {ok, remaining, retryAfter} and counts this attempt. */
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + windowMs }; hits.set(key, entry); }
      entry.count += 1;
      const remaining = Math.max(max - entry.count, 0);
      return { ok: entry.count <= max, remaining, retryAfter: Math.ceil((entry.reset - now) / 1000) };
    },
    peek(key) {
      const entry = hits.get(key);
      if (!entry || entry.reset <= Date.now()) return { count: 0 };
      return { count: entry.count, retryAfter: Math.ceil((entry.reset - Date.now()) / 1000) };
    },
    reset(key) { hits.delete(key); },
  };
}

const apiLimiter = createLimiter(config.rateMax, config.rateWindowMs);
const loginLimiter = createLimiter(config.loginMaxAttempts, config.loginWindowMs);

function rateLimit(req) {
  const { ok, retryAfter } = apiLimiter.hit(clientIp(req) || 'unknown');
  if (!ok) {
    const err = tooMany('Too many requests – please wait a moment and try again');
    err.retryAfter = retryAfter;
    throw err;
  }
}

/* ---------- who is signed in ---------- */
/** Reads the session from the cookie or an Authorization: Bearer header.
    Sets ctx.user (public shape), ctx.session and ctx.token, or leaves them null. */
async function identify(req, ctx) {
  const cookies = parseCookies(req);
  let token = cookies[config.sessionCookie] || '';
  let viaCookie = Boolean(token);

  const auth = req.headers.authorization || '';
  if (!token && /^Bearer\s+/i.test(auth)) { token = auth.replace(/^Bearer\s+/i, '').trim(); viaCookie = false; }

  ctx.user = null; ctx.session = null; ctx.token = null; ctx.viaCookie = viaCookie; ctx.cookies = cookies;
  if (!token) return ctx;

  const session = await sessions.find(token);
  if (!session) return ctx;

  const user = await users.byEmail(session.email);
  if (!user) { await sessions.destroy(token); return ctx; }

  ctx.user = user;
  ctx.session = session;
  ctx.token = token;
  return ctx;
}

/** Throws 401 when nobody is signed in. */
function requireUser(ctx) {
  if (!ctx.user) throw unauthorized('Please sign in to continue');
  return ctx.user;
}

/** Double-submit CSRF check: changing requests made with the session cookie must also send the
    token from the readable `tracker_csrf` cookie in an X-CSRF-Token header. Bearer callers (the
    tests, scripts, other origins) are exempt because they do not send cookies automatically. */
function requireCsrf(req, ctx) {
  if (!ctx.session || !ctx.viaCookie) return;
  const sent = req.headers['x-csrf-token'] || '';
  if (!safeEqual(sent, ctx.session.csrf)) {
    throw forbidden('Your page is out of date – please reload and try again');
  }
}

module.exports = { createLimiter, apiLimiter, loginLimiter, rateLimit, identify, requireUser, requireCsrf };
