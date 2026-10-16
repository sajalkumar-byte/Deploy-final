'use strict';
/* hash-compat.test.js – the two backends share one spreadsheet, so they must agree about
   passwords.

   Apps Script cannot run scrypt, so it hashes with repeated SHA-256; this server prefers
   scrypt. If each only understood its own format, every account made through the spreadsheet
   would be refused here, and pointing this server at a working sheet would lock everyone out.

   These tests run the genuine Code.gs, through the same harness its own suite uses, and check
   the two implementations against each other rather than against a copied-in constant. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { load } = require(path.resolve(__dirname, '../../google-apps-script/test/harness.js'));
const { hashPassword, hashPasswordSheets, verifyPassword } = require('../src/model/crypto');

test('a password hashed by Apps Script is accepted here', () => {
  const { sandbox } = load();
  const stored = sandbox.hashPassword_('Admin@1234');

  assert.match(stored, /^sha256\$500\$/);
  assert.equal(verifyPassword('Admin@1234', stored), true);
  assert.equal(verifyPassword('Admin@12345', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('a password hashed here in the spreadsheet format is accepted by Apps Script', () => {
  const { sandbox } = load();
  const stored = hashPasswordSheets('Correct horse battery staple');

  assert.equal(sandbox.verifyPassword_('Correct horse battery staple', stored), true);
  assert.equal(sandbox.verifyPassword_('correct horse battery staple', stored), false);
});

test('the two produce the same hash from the same salt', () => {
  const { sandbox } = load();
  const salt = 'AbCdEf0123456789';
  assert.equal(
    hashPasswordSheets('one more thing', salt),
    sandbox.hashPassword_('one more thing', salt),
    'the salt, the rounds and every byte must line up'
  );
});

test('scrypt is still what new accounts get, and is still read correctly', () => {
  const stored = hashPassword('a different secret');
  assert.match(stored, /^scrypt\$/);
  assert.equal(verifyPassword('a different secret', stored), true);
  assert.equal(verifyPassword('a different secrel', stored), false);
});

test('rubbish in the password column is refused rather than crashing', () => {
  for (const stored of ['', 'plaintext', 'sha256$', 'sha256$x$y$z', 'scrypt$1$2$3', null, undefined, 42]) {
    assert.equal(verifyPassword('anything', stored), false, `stored: ${String(stored)}`);
  }
});
