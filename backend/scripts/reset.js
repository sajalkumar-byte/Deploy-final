'use strict';
/* reset.js – delete the database file and start again with a fresh seeded super admin.
   Usage:  npm run reset            (asks for confirmation via the --yes flag)
           npm run reset -- --yes   */

const fs = require('node:fs');
const config = require('../src/config');
const db = require('../src/db');

const yes = process.argv.includes('--yes') || process.argv.includes('-y');

if (!yes) {
  console.log('This deletes every account, item and audit entry in:');
  console.log(`  ${config.dbFile}`);
  console.log('Run it again with --yes to confirm:  npm run reset -- --yes');
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm']) {
  const file = config.dbFile + suffix;
  if (fs.existsSync(file)) { fs.unlinkSync(file); console.log(`removed ${file}`); }
}

db.init(config, msg => console.log(`[setup] ${msg}`));
console.log('Fresh database ready.');
db.close();
