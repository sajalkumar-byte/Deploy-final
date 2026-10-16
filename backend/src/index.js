'use strict';
/* index.js – start the server. `npm start` from the server folder. */

const config = require('./config');
const store = require('./model/store');
const sessions = require('./model/sessions');
const { createApp } = require('./presenter/app');

async function start() {
  const seedLog = msg => console.log(`[setup] ${msg}`);
  const server = await createApp({ initDb: true, log: seedLog });

  /* Housekeeping: drop expired sessions every 15 minutes. */
  const sweep = setInterval(async () => {
    try {
      const removed = await sessions.purgeExpired();
      if (removed) console.log(`[cleanup] removed ${removed} expired session(s)`);
    } catch (e) { console.error('[cleanup]', e.message); }
  }, 15 * 60 * 1000);
  sweep.unref?.();

  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log('');
    console.log('  Task and Project Tracker – backend');
    console.log(`  API        http://${shown}:${config.port}/api`);
    if (config.serveStatic) console.log(`  Tracker    http://${shown}:${config.port}/`);
    console.log(`  Storage    ${store.get().describe()}`);
    if (server.live) console.log(`  Chat       Socket.IO on ws://${shown}:${config.port}/socket.io`);
    console.log(`  Mode       ${config.env}`);
    console.log('');
  });

  const shutdown = signal => {
    console.log(`\n[${signal}] shutting down…`);
    clearInterval(sweep);
    server.close(async () => {
      if (server.live) await server.live.close();
      await store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

  return server;
}

if (require.main === module) start().catch(err => { console.error(err); process.exit(1); });

module.exports = { start };
