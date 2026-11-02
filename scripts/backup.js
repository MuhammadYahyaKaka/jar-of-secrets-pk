/**
 * Copies the database to DATA_DIR/backups/store-<timestamp>.sqlite with VACUUM INTO.
 * Safe to run while the server is running.
 * Run: npm run backup
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, UPLOADS_DIR, DB_FILE } = require('../lib/db');

if (!fs.existsSync(DB_FILE)) {
  console.error(`No database found at ${DB_FILE}. Start the server once first.`);
  process.exit(1);
}

const backupDir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
let target = path.join(backupDir, `store-${stamp}.sqlite`);
// VACUUM INTO refuses to overwrite, so a second backup in the same second gets a suffix.
for (let n = 2; fs.existsSync(target); n++) target = path.join(backupDir, `store-${stamp}-${n}.sqlite`);

const db = new DatabaseSync(DB_FILE);
try {
  db.exec('PRAGMA busy_timeout = 5000');
  db.prepare('VACUUM INTO ?').run(target);
} finally {
  db.close();
}

console.log(`Backup written to ${target}`);
console.log(`Note: this covers the database only. Copy ${UPLOADS_DIR} as well to keep product images and payment screenshots.`);
