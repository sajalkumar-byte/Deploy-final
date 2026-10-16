'use strict';
/* static.js – serves the existing frontend (index.html, js/, css/, vendor/, assets/, config/)
   from the same origin as the API, so the browser needs no CORS and session cookies just work.
   Set SERVE_STATIC=0 to run the API on its own. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/* Never serve these from the project folder, even though they sit next to the frontend. */
const BLOCKED = [/^server([\\/]|$)/i, /^\.git([\\/]|$)/i, /^node_modules([\\/]|$)/i,
                 /^\.env/i, /^\.vercel([\\/]|$)/i, /(^|[\\/])\.DS_Store$/i];

function serve(req, res, rootDir, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  /* Resolve inside the root only – blocks ../ traversal. */
  const full = path.resolve(rootDir, rel);
  const root = path.resolve(rootDir);
  if (full !== root && !full.startsWith(root + path.sep)) return false;

  const relFromRoot = path.relative(root, full);
  if (BLOCKED.some(re => re.test(relFromRoot))) return false;

  let stat;
  try { stat = fs.statSync(full); } catch { return false; }
  if (stat.isDirectory()) return serve(req, res, rootDir, pathname.replace(/\/*$/, '/') + 'index.html');
  if (!stat.isFile()) return false;

  const ext = path.extname(full).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  /* The page itself must never be cached hard, or a deploy leaves people on the old build.
     Fingerprinted vendor files can be cached for a day. */
  const cache = ext === '.html'
    ? 'no-cache'
    : (relFromRoot.startsWith('vendor') ? 'public, max-age=86400' : 'public, max-age=300');

  const headers = {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cache,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  };

  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return true; }

  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
  return true;
}

module.exports = { serve, TYPES };
