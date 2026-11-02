/**
 * Replaces the admin account and signs everyone out. This is the recovery route for a lost password.
 * Run: npm run admin:reset
 */
'use strict';
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { openDatabase, tx } = require('../lib/db');
const { newId, hashPassword } = require('../lib/util');

// In a terminal, readline echoes what is typed. Muting its output keeps the password off the screen.
let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});

const rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt, { hidden = false } = {}) {
  process.stdout.write(prompt);
  muted = hidden;
  const { value, done } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  if (done) throw new Error('Input ended before an answer was given.');
  return value;
}

async function main() {
  const username = (await ask('New admin username: ')).trim();
  if (username.length < 3 || username.length > 64) throw new Error('The username must be 3 to 64 characters.');

  const password = await ask('New admin password: ', { hidden: true });
  if (password.length < 8 || password.length > 1024) throw new Error('The password must be at least 8 characters.');
  if (process.stdin.isTTY) {
    const again = await ask('Type the password again: ', { hidden: true });
    if (again !== password) throw new Error('The passwords did not match.');
  }

  const { salt, hash } = await hashPassword(password);
  const db = openDatabase();
  try {
    tx(db, () => {
      db.exec('DELETE FROM sessions');
      db.exec('DELETE FROM admin_users');
      db.prepare('INSERT INTO admin_users (id, username, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(newId('ADM'), username, salt, hash, new Date().toISOString());
    });
  } finally {
    db.close();
  }
  console.log(`Admin account is now "${username}". All sessions were signed out.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
