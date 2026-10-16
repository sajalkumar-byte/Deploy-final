'use strict';
/* http.js – small helpers shared by every route: reading the body, sending JSON,
   cookies, client IP, and a typed error used to return a specific status code. */

const config = require('../config');

/** Throwable error that carries an HTTP status and a short machine-readable code. */
class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code || 'error';
    if (extra) Object.assign(this, extra);
  }
}
const badRequest = (m, code) => new HttpError(400, m, code || 'bad_request');
const unauthorized = (m) => new HttpError(401, m || 'Please sign in', 'unauthorized');
const forbidden = (m) => new HttpError(403, m || 'Not allowed', 'forbidden');
const notFound = (m) => new HttpError(404, m || 'Not found', 'not_found');
const conflict = (m) => new HttpError(409, m || 'Already exists', 'conflict');
const tooMany = (m) => new HttpError(429, m || 'Too many requests', 'rate_limited');

/** Read and parse a JSON request body, with a size limit. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > config.bodyLimitBytes) {
        reject(new HttpError(413, 'Request body is too large', 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const value = JSON.parse(text);
        resolve(value && typeof value === 'object' ? value : {});
      } catch {
        reject(badRequest('The request body is not valid JSON', 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload === undefined ? null : payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

/** Queue a Set-Cookie header (several cookies may be set on one response). */
function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) bits.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  if (opts.secure ?? config.cookieSecure) bits.push('Secure');
  bits.push(`SameSite=${opts.sameSite || 'Lax'}`);
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing.slice() : [existing]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(res, name, opts = {}) {
  setCookie(res, name, '', { ...opts, maxAge: 0 });
}

/** Best-effort client address, honouring a reverse proxy's X-Forwarded-For. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket && (req.socket.remoteAddress || '')) || '';
}

module.exports = {
  HttpError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany,
  readJson, sendJson, sendText, parseCookies, setCookie, clearCookie, clientIp,
};
