/**
 * SQLite: opening the database, the schema, and the one-time migrations.
 *
 * Every migration runs in one transaction and records itself in the meta table, so it can never run
 * twice. A later admin edit or delete is therefore never undone by a restart.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const museCatalog = require('./muse-catalog');
const { newId, randomFileName, decodeBase64Strict, detectFileType, normalizeMobile } = require('./util');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(ROOT, 'uploads'));
const DB_FILE = path.join(DATA_DIR, 'store.sqlite');

const ORDER_STATUSES = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const PAYMENT_STATUSES = ['Unpaid', 'Pending Verification', 'Paid', 'Rejected', 'Refunded'];
const COD_PAYMENT_STATUSES = ['Unpaid', 'Paid', 'Refunded'];

const DEFAULT_SETTINGS = {
  storeName: 'Jar of Secrets PK',
  deliveryCity: 'Karachi',
  deliveryFee: '250',
  bankName: '',
  bankAccountTitle: '',
  bankAccountNumber: '',
  bankIban: '',
  paymentInstructions: '',
  whatsappNumber: '',
  whatsappApiToken: '',
  whatsappPhoneNumberId: '',
  notificationEmail: '',
};

// The five sample products in the original db.json. Showing them next to the Muse catalogue would put
// two different "Love Notes Jar" prices on the store, so the Muse migration disables them.
const LEGACY_SAMPLE_PRODUCT_IDS = ['prod-love-notes-jar', 'prod-secret-candle', 'prod-anniversary-gift-set', 'prod-keyhole-necklace', 'prod-birthday-jar'];

const sqlList = (values) => values.map((v) => `'${v}'`).join(', ');

const SCHEMA_V1 = `
  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0),
    category TEXT NOT NULL DEFAULT 'General',
    short_description TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    specifications TEXT NOT NULL DEFAULT '',
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    emoji TEXT NOT NULL DEFAULT '',
    art TEXT,                            -- JSON: {kind,color,label} or NULL
    images TEXT NOT NULL DEFAULT '[]',   -- JSON array of /uploads/products/... URLs
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mobile TEXT NOT NULL,                -- normalised; see normalizeMobile()
    whatsapp TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  -- Only imported legacy rows can have a blank mobile; checkout always requires one.
  CREATE UNIQUE INDEX customers_mobile_unique ON customers (mobile) WHERE mobile <> '';

  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT REFERENCES customers (id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,         -- snapshot of the details given at checkout
    customer_mobile TEXT NOT NULL,
    customer_whatsapp TEXT NOT NULL,
    customer_email TEXT NOT NULL DEFAULT '',
    customer_address TEXT NOT NULL,
    customer_city TEXT NOT NULL,
    subtotal INTEGER NOT NULL,
    delivery_fee INTEGER NOT NULL,
    total INTEGER NOT NULL,
    payment_method TEXT NOT NULL CHECK (payment_method IN ('cod', 'online')),
    payment_status TEXT NOT NULL CHECK (payment_status IN (${sqlList(PAYMENT_STATUSES)})),
    order_status TEXT NOT NULL CHECK (order_status IN (${sqlList(ORDER_STATUSES)})),
    stock_deducted INTEGER NOT NULL DEFAULT 1 CHECK (stock_deducted IN (0, 1)),
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (payment_method = 'online' OR payment_status IN (${sqlList(COD_PAYMENT_STATUSES)}))
  ) STRICT;
  CREATE INDEX orders_created_at ON orders (created_at);
  CREATE INDEX orders_customer_id ON orders (customer_id);

  -- A snapshot: deliberately no foreign key to products, so a product can be deleted.
  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    image TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE INDEX order_items_order_id ON order_items (order_id);
  CREATE INDEX order_items_image ON order_items (image);

  CREATE TABLE payment_screenshots (
    id INTEGER PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders (id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    original_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE order_history (
    id INTEGER PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    field TEXT NOT NULL CHECK (field IN ('created', 'orderStatus', 'paymentStatus')),
    from_value TEXT,
    to_value TEXT,
    note TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE INDEX order_history_order_id ON order_history (order_id);

  CREATE TABLE admin_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,         -- sha256 of the token; the token itself is never stored
    admin_id TEXT NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,         -- epoch milliseconds
    expires_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE notification_logs (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX notification_logs_created_at ON notification_logs (created_at);
`;

// ---------- Small helpers ----------

/** Runs fn in a write transaction. fn must be synchronous; the transaction rolls back if it throws. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/** Call inside the same transaction as every write to products, orders or settings. */
function bumpRevision(db) {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
}

/** One customer row per normalised mobile, holding the latest details. Returns the customer id. */
function upsertCustomer(db, customer, now) {
  const existing = customer.mobile ? db.prepare('SELECT id FROM customers WHERE mobile = ?').get(customer.mobile) : null;
  if (existing) {
    db.prepare('UPDATE customers SET name = ?, whatsapp = ?, email = ?, address = ?, city = ?, updated_at = ? WHERE id = ?')
      .run(customer.name, customer.whatsapp, customer.email, customer.address, customer.city, now, existing.id);
    return existing.id;
  }
  const id = newId('CUS');
  db.prepare('INSERT INTO customers (id, name, mobile, whatsapp, email, address, city, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, customer.name, customer.mobile, customer.whatsapp, customer.email, customer.address, customer.city, now, now);
  return id;
}

function removeFiles(files) {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not remove file:', file, error.message);
    }
  }
}

// ---------- Migration: schema ----------

function migrateSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
  if (Number(getMeta(db, 'schema_version')) >= 1) return;
  tx(db, () => {
    db.exec(SCHEMA_V1);
    const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value);
    setMeta(db, 'revision', 1);
    setMeta(db, 'schema_version', 1);
  });
}

// ---------- Migration: legacy db.json import ----------

const text = (value) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
const money = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);

function isoDate(value, fallback) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toISOString() : fallback;
}

function mapPaymentStatus(oldStatus, method) {
  const mapped = {
    'Payment Verification Pending': 'Pending Verification',
    'Cash on Delivery': 'Unpaid',
    'Payment Verified': 'Paid',
    'Payment Rejected': 'Rejected',
  }[oldStatus] || oldStatus;
  const allowed = method === 'cod' ? COD_PAYMENT_STATUSES : PAYMENT_STATUSES;
  if (allowed.includes(mapped)) return mapped;
  return method === 'cod' ? 'Unpaid' : 'Pending Verification';
}

function readLegacyFile(file) {
  const problem = (reason) => new Error(
    `${file} is corrupt and has not been imported (${reason}).\n` +
    'The server will not start with an empty store, because that could hide your data. ' +
    'Restore a good copy of this file, or move it out of this folder if you really want to start without it.'
  );
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw problem(error.message);
  }
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw problem('expected a JSON object');
  for (const key of ['products', 'customers', 'orders', 'paymentScreenshots', 'adminUsers', 'notificationLogs']) {
    if (legacy[key] !== undefined && !Array.isArray(legacy[key])) throw problem(`"${key}" is not a list`);
  }
  if (legacy.websiteSettings !== undefined && (typeof legacy.websiteSettings !== 'object' || legacy.websiteSettings === null)) {
    throw problem('"websiteSettings" is not an object');
  }
  return legacy;
}

/** Writes an image held as a data: URL to uploads/products/ and returns its URL, or '' if it is not usable. */
function saveLegacyImage(value, uploadsDir, written, savedByDataUrl) {
  if (typeof value !== 'string' || !value) return '';
  if (/^\/uploads\/products\/[0-9a-f]{32}\.(jpg|png|webp)$/.test(value)) return value;
  if (savedByDataUrl.has(value)) return savedByDataUrl.get(value);
  const buffer = /^data:/i.test(value) ? decodeBase64Strict(value) : null;
  const type = buffer && detectFileType(buffer);
  if (!type || type.kind === 'pdf') {
    console.warn(`Legacy import: skipped an image that is not a usable JPEG, PNG or WebP (${value.slice(0, 40)}...).`);
    return '';
  }
  const fileName = randomFileName(type.ext);
  const fullPath = path.join(uploadsDir, 'products', fileName);
  written.push(fullPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, buffer);
  const url = `/uploads/products/${fileName}`;
  savedByDataUrl.set(value, url);
  return url;
}

function importLegacyProducts(db, legacy, importTime, museDone, saveImage) {
  const insert = db.prepare(`INSERT INTO products
    (id, name, price, category, short_description, description, specifications, stock, emoji, art, images, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING`);
  for (const p of legacy.products || []) {
    if (!p || !p.id) continue;
    const images = (Array.isArray(p.images) ? p.images : []).map(saveImage).filter(Boolean).slice(0, 4);
    const hideSample = museDone && LEGACY_SAMPLE_PRODUCT_IDS.includes(p.id);
    const createdAt = isoDate(p.createdAt, importTime);
    insert.run(text(p.id), text(p.name) || text(p.id), money(p.price), text(p.category) || 'General', text(p.shortDescription),
      text(p.description), text(p.specifications), Math.max(0, Math.floor(Number(p.stock)) || 0), text(p.emoji) || '🫙',
      JSON.stringify(images), p.enabled === false || hideSample ? 0 : 1, createdAt, isoDate(p.updatedAt, createdAt));
  }
}

/** Returns a map from each old customer id to the id of its single row (old ids repeat a mobile). */
function importLegacyCustomers(db, legacy, importTime) {
  const idMap = new Map();
  const sorted = (legacy.customers || []).filter(Boolean)
    .map((c, index) => ({ c, index, at: isoDate(c.createdAt, importTime) }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index); // oldest first, so the latest details win
  for (const { c, at } of sorted) {
    const id = upsertCustomer(db, {
      name: text(c.name), mobile: normalizeMobile(c.mobile), whatsapp: text(c.whatsapp), email: text(c.email),
      address: text(c.address), city: text(c.city),
    }, at);
    if (c.id) idMap.set(c.id, id);
  }
  return idMap;
}

function importLegacyOrders(db, legacy, customerIds, importTime, saveImage) {
  const seenKeys = new Set();
  const insertOrder = db.prepare(`INSERT INTO orders
    (id, customer_id, customer_name, customer_mobile, customer_whatsapp, customer_email, customer_address, customer_city,
     subtotal, delivery_fee, total, payment_method, payment_status, order_status, stock_deducted, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`);
  const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity, image) VALUES (?, ?, ?, ?, ?, ?)');
  const insertHistory = db.prepare(`INSERT INTO order_history (order_id, at, field, from_value, to_value, note, actor)
    VALUES (?, ?, 'created', NULL, ?, 'Imported from the old db.json', 'system')`);
  const orderExists = db.prepare('SELECT 1 FROM orders WHERE id = ?');
  const customerByMobile = db.prepare('SELECT id FROM customers WHERE mobile = ?');

  for (const o of legacy.orders || []) {
    if (!o || !o.id || orderExists.get(text(o.id))) continue;
    const snapshot = o.customer && typeof o.customer === 'object' ? o.customer : {};
    const customer = {
      name: text(snapshot.name), mobile: text(snapshot.mobile), whatsapp: text(snapshot.whatsapp), email: text(snapshot.email),
      address: text(snapshot.address), city: text(snapshot.city),
    };
    const createdAt = isoDate(o.createdAt, importTime);
    const mobileKey = normalizeMobile(customer.mobile);
    const known = mobileKey ? customerByMobile.get(mobileKey) : null;
    let customerId = known ? known.id : customerIds.get(o.customerId) || null;
    if (!customerId && mobileKey) customerId = upsertCustomer(db, { ...customer, mobile: mobileKey }, createdAt);

    const method = o.paymentMethod === 'cod' ? 'cod' : 'online';
    const orderStatus = ORDER_STATUSES.includes(o.orderStatus) ? o.orderStatus : 'Pending';
    // stock_deducted stays 1 for Cancelled orders too: the old code never gave their stock back, so taking
    // one out of Cancelled later must not deduct a second time.
    const key = o.idempotencyKey && !seenKeys.has(o.idempotencyKey) ? text(o.idempotencyKey) : null;
    if (key) seenKeys.add(key);
    insertOrder.run(text(o.id), customerId, customer.name, customer.mobile, customer.whatsapp, customer.email, customer.address, customer.city,
      money(o.subtotal), money(o.deliveryFee), money(o.total), method, mapPaymentStatus(o.paymentStatus, method), orderStatus,
      key, createdAt, isoDate(o.updatedAt, createdAt));
    for (const item of Array.isArray(o.items) ? o.items : []) {
      if (!item) continue;
      insertItem.run(text(o.id), text(item.productId), text(item.name), money(item.price), Math.max(1, Math.floor(Number(item.quantity)) || 1), saveImage(item.image));
    }
    insertHistory.run(text(o.id), createdAt, orderStatus);
  }
}

function importLegacyScreenshots(db, legacy, uploadsDir, importTime) {
  const records = (legacy.paymentScreenshots || []).filter(Boolean);
  const recorded = new Set(records.map((r) => r.orderId));
  for (const o of legacy.orders || []) {
    if (o && o.paymentScreenshotFile && !recorded.has(o.id)) {
      records.push({ orderId: o.id, fileName: o.paymentScreenshotFile, createdAt: o.createdAt });
    }
  }
  const orderExists = db.prepare('SELECT 1 FROM orders WHERE id = ?');
  const insert = db.prepare(`INSERT INTO payment_screenshots (order_id, file_name, mime, size, original_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (order_id) DO NOTHING`);
  for (const r of records) {
    if (!r.fileName || !orderExists.get(text(r.orderId))) continue;
    const fileName = path.basename(text(r.fileName).replace(/\\/g, '/'));
    // The old server trusted the client's type, so look at the file itself. If it is not a JPEG, PNG
    // or PDF, the mime below makes the Admin download it rather than display it.
    let mime = 'application/octet-stream';
    let size = money(r.size);
    try {
      const contents = fs.readFileSync(path.join(uploadsDir, 'screenshots', fileName));
      const type = detectFileType(contents);
      if (type && type.kind !== 'webp') mime = type.mime;
      size = contents.length;
    } catch (error) {
      console.warn(`Legacy import: the screenshot file for order ${r.orderId} was not found (${fileName}).`);
    }
    insert.run(text(r.orderId), fileName, mime, size, text(r.originalName), isoDate(r.createdAt, importTime));
  }
}

function importLegacyAdmins(db, legacy, importTime) {
  if (db.prepare('SELECT 1 FROM admin_users LIMIT 1').get()) return;
  const insert = db.prepare(`INSERT INTO admin_users (id, username, salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  for (const a of legacy.adminUsers || []) {
    if (!a || !a.username || !a.salt || !a.passwordHash) continue;
    insert.run(text(a.id) || newId('ADM'), text(a.username), text(a.salt), text(a.passwordHash), isoDate(a.createdAt, importTime));
  }
}

function importLegacySettings(db, legacy) {
  const current = db.prepare('SELECT value FROM settings WHERE key = ?');
  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  const old = legacy.websiteSettings || {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (old[key] === undefined || old[key] === null) continue;
    // Only replaces untouched defaults: this matters if db.json is copied in after the store is live.
    if (current.get(key).value !== DEFAULT_SETTINGS[key]) continue;
    update.run(key === 'deliveryFee' ? String(money(old[key])) : text(old[key]), key);
  }
}

function importLegacyNotifications(db, legacy, importTime) {
  const insert = db.prepare(`INSERT INTO notification_logs (id, order_id, channel, recipient, subject, body, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`);
  for (const n of legacy.notificationLogs || []) {
    if (!n) continue;
    insert.run(text(n.id) || newId('NTF'), text(n.orderId), text(n.channel), text(n.to), text(n.subject), text(n.body),
      text(n.status) || 'logged', text(n.error), isoDate(n.createdAt, importTime));
  }
}

/** Reads db.json only; it is never modified or deleted. */
function migrateLegacyImport(db, dataDir, uploadsDir) {
  const file = path.join(dataDir, 'db.json');
  if (getMeta(db, 'legacy_import') || !fs.existsSync(file)) return;
  const legacy = readLegacyFile(file);
  const importTime = new Date().toISOString();
  const museDone = Boolean(getMeta(db, 'muse_catalog'));
  const written = [];
  const savedByDataUrl = new Map();
  const saveImage = (value) => saveLegacyImage(value, uploadsDir, written, savedByDataUrl);
  try {
    tx(db, () => {
      importLegacyProducts(db, legacy, importTime, museDone, saveImage);
      const customerIds = importLegacyCustomers(db, legacy, importTime);
      importLegacyOrders(db, legacy, customerIds, importTime, saveImage);
      importLegacyScreenshots(db, legacy, uploadsDir, importTime);
      importLegacyAdmins(db, legacy, importTime);
      importLegacySettings(db, legacy);
      importLegacyNotifications(db, legacy, importTime);
      setMeta(db, 'legacy_import', importTime);
    });
  } catch (error) {
    removeFiles(written);
    throw new Error(`Importing ${file} failed and was rolled back: ${error.message}`, { cause: error });
  }
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  console.log(`Imported ${file}: ${count('products')} products, ${count('customers')} customers, ${count('orders')} orders, ${count('admin_users')} admins.`);
}

// ---------- Migration: Muse catalogue ----------

function migrateMuseCatalog(db) {
  if (getMeta(db, 'muse_catalog')) return;
  const now = new Date().toISOString();
  tx(db, () => {
    const insert = db.prepare(`INSERT INTO products
      (id, name, price, category, short_description, description, specifications, stock, emoji, art, images, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 1, ?, ?)
      ON CONFLICT (id) DO NOTHING`);
    for (const p of museCatalog) {
      insert.run(p.id, p.name, p.price, p.category, p.shortDescription, p.description, p.specifications, p.stock, p.emoji, JSON.stringify(p.art), now, now);
    }
    const disable = db.prepare('UPDATE products SET enabled = 0, updated_at = ? WHERE id = ?');
    for (const id of LEGACY_SAMPLE_PRODUCT_IDS) disable.run(now, id);
    setMeta(db, 'muse_catalog', now);
  });
  console.log('Added the 6 Muse products and disabled the 5 legacy sample products.');
}

// ---------- Open ----------

/** Opens the database and applies pending migrations. Throws with a clear message if db.json is corrupt. */
function openDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(UPLOADS_DIR, 'products'), { recursive: true });
  fs.mkdirSync(path.join(UPLOADS_DIR, 'screenshots'), { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    migrateSchema(db);
    migrateLegacyImport(db, DATA_DIR, UPLOADS_DIR);
    migrateMuseCatalog(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

module.exports = {
  DATA_DIR, UPLOADS_DIR, DB_FILE, ORDER_STATUSES, PAYMENT_STATUSES, COD_PAYMENT_STATUSES,
  openDatabase, tx, getMeta, bumpRevision, upsertCustomer, removeFiles,
};
