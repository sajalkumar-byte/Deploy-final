'use strict';
/* router.js – a tiny router: register `METHOD /path/:param` patterns and get back
   the handler plus the captured parameters. Keeps the server dependency-free. */

class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const parts = pattern.split('/').filter(Boolean);
    this.routes.push({ method: method.toUpperCase(), parts, handler, pattern });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  /** Returns {handler, params} for an exact match, {allowed:[...]} when only the method differs,
      or null when the path is unknown. */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const pathMatches = [];
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const seg = route.parts[i];
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          ok = false; break;
        }
      }
      if (!ok) continue;
      pathMatches.push(route);
      if (route.method === method.toUpperCase()) return { handler: route.handler, params, route };
    }
    if (pathMatches.length) return { allowed: [...new Set(pathMatches.map(r => r.method))] };
    return null;
  }
}

module.exports = { Router };
