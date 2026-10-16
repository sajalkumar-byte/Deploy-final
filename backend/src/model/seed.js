'use strict';
/* seed.js – create the first accounts when the storage is completely empty.
   Runs on every start-up but does nothing once any account exists. */

const config = require('../config');
const users = require('./users');

async function ensureSeedAccounts(log = () => {}) {
  if (await users.count() > 0) return { seeded: false };

  const accounts = [
    { ...config.seedSuperAdmin, role: 'superadmin' },
    ...(config.seedTestAdmin ? [config.seedTestAdmin] : []),
  ];
  for (const account of accounts) {
    await users.create({
      email: account.email, name: account.name, role: account.role,
      password: account.password, createdBy: 'seed',
    });
    log(`seeded ${account.role}: ${account.email}`);
  }
  return { seeded: true, accounts: accounts.map(a => a.email) };
}

module.exports = { ensureSeedAccounts };
