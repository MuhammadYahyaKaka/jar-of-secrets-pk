/**
 * Jar of Secrets PK — store server. docs/API.md is the contract for every route here.
 * Zero npm dependencies: Node.js built-ins only.
 * Run: node server.js
 *
 * Handlers do their database work synchronously (node:sqlite is synchronous), so once a request body has
 * been read, nothing else can run until that handler finishes. Two orders can never interleave.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  UPLOADS_DIR, ORDER_STATUSES, PAYMENT_STATUSES, COD_PAYMENT_STATUSES,
  openDatabase, tx, getMeta, bumpRevision, upsertCustomer, removeFiles,
} = require('./lib/db');
const { newOrderId, newId, randomFileName, decodeBase64Strict, detectFileType, normalizeMobile, hashPassword, verifyPassword } = require('./lib/util');

// ---------- Configuration ----------

const PORT = process.env.PORT === undefined || process.env.PORT === '' ? 3000 : Number(process.env.PORT);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRODUCT_IMAGE_DIR = path.join(UPLOADS_DIR, 'products');
const SCREENSHOT_DIR = path.join(UPLOADS_DIR, 'screenshots');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean));

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const MB = 1024 * 1024;

const BODY_LIMIT_DEFAULT = 64 * 1024;
const BODY_LIMIT_ORDER = 8 * MB;
const BODY_LIMIT_PRODUCT = 32 * MB;
const MAX_DRAIN_BYTES = 64 * MB; // past this much surplus, stop being polite and close the connection
const MAX_FILE_BYTES = 5 * MB;

const SESSION_TTL = 12 * HOUR;
const SESSION_TOUCH_INTERVAL = 5 * MINUTE;
const LOGIN_MAX_FAILURES = 8;
const LOGIN_WINDOW = 15 * MINUTE;
const ORDER_RATE_WINDOW = 10 * MINUTE;
const envOrderLimit = Number(process.env.ORDER_RATE_LIMIT);
const ORDER_RATE_LIMIT = Number.isInteger(envOrderLimit) && envOrderLimit > 0 ? envOrderLimit : 10;

const SHIPPING_CITIES = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Quetta', 'Hyderabad', 'Sialkot', 'Other'];

const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SCREENSHOT_CSP = "sandbox; default-src 'none'";

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const PRODUCT_IMAGE_TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

let db;

// ---------- Errors and responses ----------

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new ApiError(status, code, message);
}

const invalid = (message) => fail(400, 'VALIDATION', message);
const notFound = (what = 'Not found.') => fail(404, 'NOT_FOUND', what);

function sendJSON(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendNotFoundPage(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function handleError(req, res, error) {
  if (res.headersSent) {
    console.error('Error after the response started:', error);
    res.destroy();
    return;
  }
  if (error instanceof ApiError) {
    const headers = error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {};
    if (error.closeConnection) {
      // The client kept sending far past the limit. Answer, then hang up.
      headers.Connection = 'close';
      res.on('finish', () => req.destroy());
    }
    sendJSON(res, error.status, { error: error.message, code: error.code }, headers);
    return;
  }
  if (error && error.clientGone) return;
  console.error(`Unhandled error on ${req.method} ${String(req.url).split('?')[0]}:`, error);
  sendJSON(res, 500, { error: 'Something went wrong. Please try again.', code: 'SERVER_ERROR' });
}

// ---------- Reading request bodies ----------

/**
 * Reads the body as a JSON object. Past the limit it stops buffering but keeps draining, because closing the
 * socket while the client is still sending would lose the 413 response.
 */
function readJson(req, limit = BODY_LIMIT_DEFAULT) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const tooLarge = () => new ApiError(413, 'TOO_LARGE', 'That request is too large.');

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      chunks = [];
      if (size > limit + MAX_DRAIN_BYTES) {
        const error = tooLarge();
        error.closeConnection = true;
        settle(reject, error);
      }
    });
    req.on('end', () => {
      if (size > limit) return settle(reject, tooLarge());
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return settle(resolve, {});
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return settle(reject, new ApiError(400, 'VALIDATION', 'The request is not valid JSON.'));
      }
      if (!isPlainObject(value)) return settle(reject, new ApiError(400, 'VALIDATION', 'The request body must be a JSON object.'));
      settle(resolve, value);
    });
    req.on('error', (error) => settle(reject, Object.assign(error, { clientGone: true })));
    req.on('close', () => settle(reject, Object.assign(new Error('Client disconnected'), { clientGone: true })));
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------- Text validation ----------
// Handlers only ever read named fields from request objects, so a "__proto__" key in a body goes nowhere.

/** One line of text: tabs and newlines become spaces, other control characters are removed. */
function cleanLine(value) {
  return value
    .replace(/[\t\n\r\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim();
}

/** Multi-line text: keeps newlines and tabs, removes other control characters. */
function cleanBlock(value) {
  return value
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .trim();
}

function textField(value, label, { min = 0, max, multiline = false } = {}) {
  if (typeof value !== 'string') invalid(`${label} must be text.`);
  const cleaned = multiline ? cleanBlock(value) : cleanLine(value);
  if (cleaned.length < min) invalid(min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`);
  if (cleaned.length > max) invalid(`${label} must be at most ${max} characters.`);
  return cleaned;
}

function digitsAfterStripping(value, label) {
  if (typeof value !== 'string') invalid(`${label} must be text.`);
  const cleaned = cleanLine(value);
  if (!/^\d{10,15}$/.test(cleaned.replace(/[+\-() ]/g, ''))) invalid(`${label} must have 10 to 15 digits.`);
  return cleaned;
}

function isPlausibleEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function likePattern(value) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

// ---------- Rate limiting ----------

/** Counts events per key in fixed windows. Expired entries are pruned, and the map's size is capped. */
function createLimiter(windowMs, maxKeys = 20000) {
  const entries = new Map();
  const live = (key) => {
    const entry = entries.get(key);
    if (entry && entry.resetAt <= Date.now()) {
      entries.delete(key);
      return null;
    }
    return entry || null;
  };
  return {
    count: (key) => (live(key) ? live(key).count : 0),
    retryAfter: (key) => {
      const entry = live(key);
      return entry ? Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)) : 1;
    },
    hit(key) {
      const entry = live(key);
      if (entry) {
        entry.count += 1;
        return;
      }
      if (entries.size >= maxKeys) entries.delete(entries.keys().next().value); // oldest first
      entries.set(key, { count: 1, resetAt: Date.now() + windowMs });
    },
    clear: (key) => entries.delete(key),
    prune() {
      const now = Date.now();
      for (const [key, entry] of entries) if (entry.resetAt <= now) entries.delete(key);
    },
  };
}

const loginLimiter = createLimiter(LOGIN_WINDOW);
const setupLimiter = createLimiter(LOGIN_WINDOW);
const orderLimiter = createLimiter(ORDER_RATE_WINDOW);

function rateLimited(limiter, ip, message) {
  const error = new ApiError(429, 'RATE_LIMITED', message);
  error.retryAfter = limiter.retryAfter(ip);
  throw error;
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || 'unknown';
  if (TRUST_PROXY) {
    // Our own proxy appends the address it saw, so the last entry is the one a client cannot forge.
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean);
    if (forwarded.length) ip = forwarded[forwarded.length - 1];
  }
  return ip.replace(/^::ffff:/, '');
}

// ---------- Settings ----------

function getSettings() {
  const settings = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) settings[row.key] = row.value;
  settings.deliveryFee = Number(settings.deliveryFee) || 0;
  return settings;
}

const onlinePaymentAvailable = (s) => Boolean(s.bankName && s.bankAccountTitle && s.bankAccountNumber);

function deliveryCities(s) {
  return SHIPPING_CITIES.includes(s.deliveryCity) ? SHIPPING_CITIES : [s.deliveryCity, ...SHIPPING_CITIES];
}

function adminSettingsView(s) {
  const { whatsappApiToken, ...rest } = s;
  return { ...rest, whatsappApiToken: '', whatsappApiTokenSet: Boolean(whatsappApiToken) };
}

function updateSettings(body) {
  const changes = new Map();
  const put = (key, options) => {
    if (body[key] !== undefined) changes.set(key, textField(body[key], key, options));
  };
  put('storeName', { min: 1, max: 100 });
  put('deliveryCity', { min: 1, max: 100 });
  put('bankName', { max: 120 });
  put('bankAccountTitle', { max: 120 });
  put('bankAccountNumber', { max: 64 });
  put('bankIban', { max: 64 });
  put('paymentInstructions', { max: 2000, multiline: true });
  put('whatsappNumber', { max: 32 });
  put('whatsappPhoneNumberId', { max: 64 });
  put('notificationEmail', { max: 254 });
  if (changes.get('notificationEmail') && !isPlausibleEmail(changes.get('notificationEmail'))) invalid('notificationEmail is not a valid email address.');
  if (body.deliveryFee !== undefined) {
    if (!Number.isInteger(body.deliveryFee) || body.deliveryFee < 0) invalid('deliveryFee must be a whole number, 0 or more.');
    changes.set('deliveryFee', String(body.deliveryFee));
  }
  if (body.whatsappApiToken !== undefined) {
    const token = textField(body.whatsappApiToken, 'whatsappApiToken', { max: 1024 });
    if (token) changes.set('whatsappApiToken', token); // blank keeps the stored token
  }
  if (changes.size) {
    tx(db, () => {
      const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
      for (const [key, value] of changes) upsert.run(key, value);
      bumpRevision(db);
    });
  }
}

// ---------- Products ----------

function productView(row) {
  return {
    id: row.id, name: row.name, price: row.price, category: row.category, shortDescription: row.short_description,
    description: row.description, specifications: row.specifications, stock: row.stock, emoji: row.emoji,
    art: row.art ? JSON.parse(row.art) : null, images: JSON.parse(row.images), updatedAt: row.updated_at,
  };
}

function adminProductView(row) {
  return { ...productView(row), enabled: row.enabled === 1, createdAt: row.created_at };
}

function parseArt(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) invalid('art must be an object or null.');
  if (!['jar', 'candle', 'box', 'ring'].includes(value.kind)) invalid('art.kind must be jar, candle, box or ring.');
  const color = value.color === undefined ? null : value.color;
  if (color !== null && (typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color))) invalid('art.color must look like #RRGGBB or be null.');
  const label = value.label === undefined || value.label === null ? null : textField(value.label, 'art.label', { max: 60 });
  return { kind: value.kind, color, label };
}

/** Validates the desired image list. Writes nothing; see saveNewImages. */
function parseImages(value) {
  if (!Array.isArray(value)) invalid('images must be a list.');
  if (value.length > 4) invalid('A product can have at most 4 images.');
  return value.map((entry) => {
    if (typeof entry === 'string' && /^\/uploads\/products\/[0-9a-f]{32}\.(jpg|png|webp)$/.test(entry)) {
      if (!fs.existsSync(path.join(PRODUCT_IMAGE_DIR, path.basename(entry)))) invalid('One of the images no longer exists.');
      return { url: entry };
    }
    if (typeof entry !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(entry)) invalid('Each image must be JPEG, PNG or WebP.');
    const buffer = decodeBase64Strict(entry);
    if (!buffer) invalid('An image could not be decoded.');
    if (buffer.length > MAX_FILE_BYTES) invalid('Each image must be 5 MB or smaller.');
    const type = detectFileType(buffer);
    if (!type || type.kind === 'pdf') invalid('Each image must be JPEG, PNG or WebP.');
    return { buffer, ext: type.ext };
  });
}

/** Writes new image files, pushing each path onto `written` so a failed caller can remove them. */
function saveNewImages(entries, written) {
  const urls = entries.map((entry) => {
    if (entry.url) return entry.url;
    const fileName = randomFileName(entry.ext);
    const fullPath = path.join(PRODUCT_IMAGE_DIR, fileName);
    written.push(fullPath);
    fs.writeFileSync(fullPath, entry.buffer, { flush: true });
    return `/uploads/products/${fileName}`;
  });
  return [...new Set(urls)];
}

/** Removes image files that no product and no order item refers to any more. Call after the commit. */
function removeUnreferencedImages(urls) {
  const usedByProduct = db.prepare('SELECT 1 FROM products, json_each(products.images) WHERE json_each.value = ? LIMIT 1');
  const usedByOrder = db.prepare('SELECT 1 FROM order_items WHERE image = ? LIMIT 1');
  const unused = urls.filter((url) => !usedByProduct.get(url) && !usedByOrder.get(url));
  removeFiles(unused.map((url) => path.join(PRODUCT_IMAGE_DIR, path.basename(url))));
}

function parseProductBody(body, creating) {
  const input = {};
  if (creating && body.name === undefined) invalid('name is required.');
  if (body.name !== undefined) input.name = textField(body.name, 'name', { min: 1, max: 120 });
  if (creating && body.price === undefined) invalid('price is required.');
  if (body.price !== undefined) {
    if (!Number.isInteger(body.price) || body.price < 1) invalid('price must be a whole number of 1 or more.');
    input.price = body.price;
  }
  if (body.stock !== undefined) {
    if (!Number.isInteger(body.stock) || body.stock < 0) invalid('stock must be a whole number, 0 or more.');
    input.stock = body.stock;
  }
  if (body.category !== undefined) input.category = textField(body.category, 'category', { max: 60 });
  if (body.shortDescription !== undefined) input.short_description = textField(body.shortDescription, 'shortDescription', { max: 500, multiline: true });
  if (body.description !== undefined) input.description = textField(body.description, 'description', { max: 5000, multiline: true });
  if (body.specifications !== undefined) input.specifications = textField(body.specifications, 'specifications', { max: 5000, multiline: true });
  if (body.emoji !== undefined) input.emoji = textField(body.emoji, 'emoji', { max: 16 });
  if (body.art !== undefined) input.art = JSON.stringify(parseArt(body.art));
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') invalid('enabled must be true or false.');
    input.enabled = body.enabled ? 1 : 0;
  }
  return { input, images: body.images === undefined ? null : parseImages(body.images) };
}

function createProduct(body) {
  const { input, images } = parseProductBody(body, true);
  const written = [];
  try {
    const urls = saveNewImages(images || [], written);
    const now = new Date().toISOString();
    const id = newId('PROD');
    tx(db, () => {
      db.prepare(`INSERT INTO products
        (id, name, price, category, short_description, description, specifications, stock, emoji, art, images, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, input.price, input.category || 'General', input.short_description || '', input.description || '',
          input.specifications || '', input.stock ?? 0, input.emoji || '🫙', input.art === undefined || input.art === 'null' ? null : input.art,
          JSON.stringify(urls), input.enabled ?? 1, now, now);
      bumpRevision(db);
    });
    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  } catch (error) {
    removeFiles(written);
    throw error;
  }
}

function updateProduct(id, body) {
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!current) notFound('Product not found.');
  const { input, images } = parseProductBody(body, false);
  const written = [];
  const oldUrls = JSON.parse(current.images);
  let urls = oldUrls;
  try {
    if (images) urls = saveNewImages(images, written);
    const next = { ...current, ...input };
    tx(db, () => {
      db.prepare(`UPDATE products SET name = ?, price = ?, category = ?, short_description = ?, description = ?, specifications = ?,
        stock = ?, emoji = ?, art = ?, images = ?, enabled = ?, updated_at = ? WHERE id = ?`)
        .run(next.name, next.price, next.category, next.short_description, next.description, next.specifications,
          next.stock, next.emoji, next.art === 'null' ? null : next.art, JSON.stringify(urls), next.enabled, new Date().toISOString(), id);
      bumpRevision(db);
    });
  } catch (error) {
    removeFiles(written);
    throw error;
  }
  removeUnreferencedImages(oldUrls.filter((url) => !urls.includes(url)));
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

function deleteProduct(id) {
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!current) notFound('Product not found.');
  tx(db, () => {
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    bumpRevision(db);
  });
  removeUnreferencedImages(JSON.parse(current.images));
}

// ---------- Orders: reading ----------

const getItems = (orderId) => db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);

function orderCustomer(row) {
  return {
    name: row.customer_name, mobile: row.customer_mobile, whatsapp: row.customer_whatsapp,
    email: row.customer_email, address: row.customer_address, city: row.customer_city,
  };
}

function publicOrderView(row) {
  return {
    id: row.id,
    customer: orderCustomer(row),
    items: getItems(row.id).map((i) => ({ productId: i.product_id, name: i.name, price: i.price, quantity: i.quantity, lineTotal: i.price * i.quantity })),
    subtotal: row.subtotal, deliveryFee: row.delivery_fee, total: row.total,
    paymentMethod: row.payment_method, paymentStatus: row.payment_status, orderStatus: row.order_status, createdAt: row.created_at,
  };
}

function adminOrderView(row, { withHistory = false } = {}) {
  const shot = db.prepare('SELECT * FROM payment_screenshots WHERE order_id = ?').get(row.id);
  const view = {
    id: row.id,
    customerId: row.customer_id,
    customer: orderCustomer(row),
    items: getItems(row.id).map((i) => ({ productId: i.product_id, name: i.name, price: i.price, quantity: i.quantity, lineTotal: i.price * i.quantity, image: i.image })),
    subtotal: row.subtotal, deliveryFee: row.delivery_fee, total: row.total,
    paymentMethod: row.payment_method, paymentStatus: row.payment_status, orderStatus: row.order_status,
    screenshot: shot ? { mime: shot.mime, size: shot.size, originalName: shot.original_name, createdAt: shot.created_at } : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (withHistory) {
    view.history = db.prepare('SELECT * FROM order_history WHERE order_id = ? ORDER BY id').all(row.id)
      .map((h) => ({ at: h.at, field: h.field, from: h.from_value, to: h.to_value, note: h.note, actor: h.actor }));
  }
  return view;
}

function listOrders(query) {
  const where = [];
  const params = [];
  const status = query.get('status');
  const paymentStatus = query.get('paymentStatus');
  const q = cleanLine(query.get('q') || '').slice(0, 100);
  if (status) {
    where.push('o.order_status = ?');
    params.push(status);
  }
  if (paymentStatus) {
    where.push('o.payment_status = ?');
    params.push(paymentStatus);
  }
  if (q) {
    // The snapshot holds the number as typed; the customer row holds it normalised, so "03001234567"
    // also finds an order placed as "0300-1234567".
    const like = likePattern(q);
    const mobile = normalizeMobile(q);
    where.push(`(o.id LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\' OR o.customer_mobile LIKE ? ESCAPE '\\' OR o.customer_email LIKE ? ESCAPE '\\'${mobile ? " OR c.mobile LIKE ? ESCAPE '\\'" : ''})`);
    params.push(like, like, like, like);
    if (mobile) params.push(likePattern(mobile));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM orders o LEFT JOIN customers c ON c.id = o.customer_id ${clause}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;

  let limit = Number.parseInt(query.get('limit'), 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 200;
  limit = Math.min(limit, 1000);

  const rows = db.prepare(`SELECT o.* ${from} ORDER BY o.created_at DESC, o.rowid DESC LIMIT ?`).all(...params, limit);
  return { orders: rows.map((row) => adminOrderView(row)), total };
}

function getStats() {
  const p = db.prepare(`SELECT COUNT(*) AS products,
      COALESCE(SUM(enabled = 1), 0) AS activeProducts,
      COALESCE(SUM(enabled = 1 AND stock <= 5), 0) AS lowStock
    FROM products`).get();
  const o = db.prepare(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(order_status = 'Pending'), 0) AS pending,
      COALESCE(SUM(order_status = 'Confirmed'), 0) AS confirmed,
      COALESCE(SUM(order_status = 'Processing'), 0) AS processing,
      COALESCE(SUM(order_status = 'Shipped'), 0) AS shipped,
      COALESCE(SUM(order_status = 'Delivered'), 0) AS completed,
      COALESCE(SUM(order_status = 'Cancelled'), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN order_status <> 'Cancelled' AND payment_status NOT IN ('Rejected', 'Refunded') THEN total ELSE 0 END), 0) AS totalSales,
      COALESCE(SUM(CASE WHEN payment_status = 'Paid' THEN total ELSE 0 END), 0) AS paidSales,
      COALESCE(SUM(payment_status = 'Pending Verification'), 0) AS pendingVerification
    FROM orders`).get();
  return { ...p, ...o };
}

function listCustomers(query) {
  const q = cleanLine(query.get('q') || '').slice(0, 100);
  const params = [];
  let clause = '';
  if (q) {
    const like = likePattern(q);
    const mobile = normalizeMobile(q);
    clause = "WHERE c.name LIKE ? ESCAPE '\\' OR c.mobile LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\'";
    params.push(like, mobile ? likePattern(mobile) : like, like);
  }
  const rows = db.prepare(`SELECT c.*,
      COUNT(o.id) AS order_count,
      COALESCE(SUM(CASE WHEN o.order_status <> 'Cancelled' AND o.payment_status NOT IN ('Rejected', 'Refunded') THEN o.total ELSE 0 END), 0) AS total_spent,
      MIN(o.created_at) AS first_order_at,
      MAX(o.created_at) AS last_order_at
    FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
    ${clause}
    GROUP BY c.id
    ORDER BY last_order_at DESC NULLS LAST, c.rowid DESC`).all(...params);
  return rows.map((c) => ({
    id: c.id, name: c.name, mobile: c.mobile, whatsapp: c.whatsapp, email: c.email, address: c.address, city: c.city,
    orderCount: c.order_count, totalSpent: c.total_spent, firstOrderAt: c.first_order_at, lastOrderAt: c.last_order_at,
  }));
}

// ---------- Orders: creating ----------

function parseCustomer(value, settings) {
  if (!isPlainObject(value)) invalid('Please fill in your delivery details.');
  const customer = {
    name: textField(value.name, 'Name', { min: 2, max: 100 }),
    mobile: digitsAfterStripping(value.mobile, 'Mobile number'),
    whatsapp: digitsAfterStripping(value.whatsapp, 'WhatsApp number'),
    email: textField(value.email, 'Email', { min: 1, max: 254 }),
    address: textField(value.address, 'Address', { min: 8, max: 500 }),
    city: textField(value.city, 'City', { min: 1, max: 100 }),
  };
  if (!isPlausibleEmail(customer.email)) invalid('Please enter a valid email address.');
  if (!deliveryCities(settings).includes(customer.city)) invalid('Please select your city from the list.');
  if (customer.city !== settings.deliveryCity) {
    fail(422, 'CITY_NOT_SERVED', `Sorry! We currently provide delivery services only within ${settings.deliveryCity}. Delivery to your selected city is not available.`);
  }
  return customer;
}

/** Validates every line and merges duplicates, so two lines of one product cannot dodge the stock check. */
function parseItems(value) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) fail(400, 'EMPTY_CART', 'Your cart is empty.');
  if (!Array.isArray(value)) invalid('items must be a list.');
  const merged = new Map();
  for (const line of value) {
    if (!isPlainObject(line) || typeof line.productId !== 'string' || !line.productId || line.productId.length > 100) invalid('Each item needs a product.');
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 100) invalid('Each quantity must be a whole number from 1 to 100.');
    merged.set(line.productId, (merged.get(line.productId) || 0) + line.quantity);
  }
  if (merged.size > 50) invalid('An order can have at most 50 different items.');
  for (const quantity of merged.values()) if (quantity > 100) invalid('Each quantity must be a whole number from 1 to 100.');
  return merged;
}

/** Returns the decoded, type-checked screenshot. Writes nothing. */
function parseScreenshot(value) {
  if (!isPlainObject(value) || value.data === undefined || value.data === null || value.data === '') {
    fail(400, 'SCREENSHOT_REQUIRED', 'A payment screenshot is required for online bank transfer orders.');
  }
  const buffer = decodeBase64Strict(value.data);
  if (!buffer) fail(400, 'SCREENSHOT_INVALID', 'The payment screenshot could not be read. Please upload it again.');
  if (buffer.length > MAX_FILE_BYTES) fail(400, 'SCREENSHOT_INVALID', 'The payment screenshot must be 5 MB or smaller.');
  const type = detectFileType(buffer);
  if (!type || type.kind === 'webp') fail(400, 'SCREENSHOT_INVALID', 'The payment screenshot must be a JPG, PNG or PDF file.');
  const name = typeof value.name === 'string' ? cleanLine(value.name.replace(/^.*[\\/]/, '')).slice(0, 200) : '';
  return { buffer, type, originalName: name || 'screenshot' };
}

function uniqueOrderId() {
  const exists = db.prepare('SELECT 1 FROM orders WHERE id = ?');
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = newOrderId();
    if (!exists.get(id)) return id;
  }
  throw new Error('Could not generate a unique order id');
}

/** Takes stock for one line. The condition in the UPDATE is what makes overselling impossible. */
function deductStock(productId, quantity, now) {
  const result = db.prepare('UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ?').run(quantity, now, productId, quantity);
  return result.changes === 1;
}

function createOrder(body, ip) {
  if (typeof body.idempotencyKey !== 'string') invalid('idempotencyKey is required.');
  const idempotencyKey = body.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 100 || idempotencyKey !== cleanLine(idempotencyKey)) {
    invalid('idempotencyKey must be 8 to 100 characters.');
  }

  // A replay gets its original order, whatever the stock or the rate limit says now.
  const previous = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotencyKey);
  if (previous) return { status: 200, payload: { order: publicOrderView(previous), duplicate: true } };

  if (orderLimiter.count(ip) >= ORDER_RATE_LIMIT) rateLimited(orderLimiter, ip, 'Too many orders from your connection. Please try again later.');

  const items = parseItems(body.items);
  const settings = getSettings();
  const customer = parseCustomer(body.customer, settings);
  const paymentMethod = body.paymentMethod;
  if (paymentMethod !== 'cod' && paymentMethod !== 'online') invalid('paymentMethod must be cod or online.');

  let screenshot = null;
  if (paymentMethod === 'online') {
    if (!onlinePaymentAvailable(settings)) fail(409, 'ONLINE_PAYMENT_UNAVAILABLE', 'Online payment is not available right now. Please choose Cash on Delivery.');
    screenshot = parseScreenshot(body.screenshot);
  }

  const now = new Date().toISOString();
  const id = uniqueOrderId();
  let screenshotPath = null;
  try {
    tx(db, () => {
      const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
      const lines = [];
      for (const [productId, quantity] of items) {
        const product = getProduct.get(productId);
        if (!product || product.enabled !== 1) fail(409, 'PRODUCT_UNAVAILABLE', 'A product in your cart is no longer available.');
        if (!deductStock(productId, quantity, now)) fail(409, 'OUT_OF_STOCK', `Only ${product.stock} left in stock for "${product.name}".`);
        lines.push({ product, quantity });
      }
      const subtotal = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
      const total = subtotal + settings.deliveryFee;

      const customerId = upsertCustomer(db, { ...customer, mobile: normalizeMobile(customer.mobile) }, now);
      db.prepare(`INSERT INTO orders
        (id, customer_id, customer_name, customer_mobile, customer_whatsapp, customer_email, customer_address, customer_city,
         subtotal, delivery_fee, total, payment_method, payment_status, order_status, stock_deducted, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 1, ?, ?, ?)`)
        .run(id, customerId, customer.name, customer.mobile, customer.whatsapp, customer.email, customer.address, customer.city,
          subtotal, settings.deliveryFee, total, paymentMethod, paymentMethod === 'cod' ? 'Unpaid' : 'Pending Verification',
          idempotencyKey, now, now);

      const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, price, quantity, image) VALUES (?, ?, ?, ?, ?, ?)');
      for (const { product, quantity } of lines) {
        insertItem.run(id, product.id, product.name, product.price, quantity, JSON.parse(product.images)[0] || '');
      }

      if (screenshot) {
        // Only reached once everything has been validated and the stock has been taken.
        const fileName = randomFileName(screenshot.type.ext);
        screenshotPath = path.join(SCREENSHOT_DIR, fileName);
        fs.writeFileSync(screenshotPath, screenshot.buffer, { flush: true });
        db.prepare('INSERT INTO payment_screenshots (order_id, file_name, mime, size, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, fileName, screenshot.type.mime, screenshot.buffer.length, screenshot.originalName, now);
      }

      addHistory(id, now, 'created', null, 'Pending', '', 'customer');
      bumpRevision(db);
    });
  } catch (error) {
    if (screenshotPath) removeFiles([screenshotPath]);
    throw error;
  }

  orderLimiter.hit(ip);
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  notifyOrder(row).catch((error) => console.error(`Notification for order ${id} failed:`, error));
  return { status: 201, payload: { order: publicOrderView(row) } };
}

function addHistory(orderId, at, field, from, to, note, actor) {
  db.prepare('INSERT INTO order_history (order_id, at, field, from_value, to_value, note, actor) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(orderId, at, field, from, to, note, actor);
}

// ---------- Orders: admin changes ----------

function nextPaymentStatus(body, order) {
  let next = order.payment_status;
  if (body.paymentStatus !== undefined && body.paymentStatus !== null) {
    if (!PAYMENT_STATUSES.includes(body.paymentStatus)) invalid('Unknown payment status.');
    next = body.paymentStatus;
  }
  if (body.paymentAction !== undefined && body.paymentAction !== null) {
    if (body.paymentAction !== 'verify' && body.paymentAction !== 'reject') invalid('paymentAction must be verify or reject.');
    if (order.payment_method !== 'online') invalid('Only online payments can be verified or rejected.');
    const fromAction = body.paymentAction === 'verify' ? 'Paid' : 'Rejected';
    if (body.paymentStatus !== undefined && body.paymentStatus !== null && body.paymentStatus !== fromAction) invalid('paymentStatus and paymentAction disagree.');
    next = fromAction;
  }
  if (order.payment_method === 'cod' && !COD_PAYMENT_STATUSES.includes(next)) invalid('Cash on Delivery orders can only be Unpaid, Paid or Refunded.');
  return next;
}

function updateOrder(id, body, actor) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) notFound('Order not found.');

  let nextOrder = order.order_status;
  if (body.orderStatus !== undefined && body.orderStatus !== null) {
    if (!ORDER_STATUSES.includes(body.orderStatus)) invalid('Unknown order status.');
    nextOrder = body.orderStatus;
  }
  const nextPayment = nextPaymentStatus(body, order);
  const note = body.note === undefined || body.note === null ? '' : textField(body.note, 'note', { max: 500, multiline: true });

  const orderChanged = nextOrder !== order.order_status;
  const paymentChanged = nextPayment !== order.payment_status;
  if (orderChanged || paymentChanged) {
    const now = new Date().toISOString();
    tx(db, () => {
      let stockDeducted = order.stock_deducted;
      if (nextOrder === 'Cancelled' && stockDeducted === 1) {
        const restore = db.prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?');
        for (const item of getItems(id)) restore.run(item.quantity, now, item.product_id);
        stockDeducted = 0;
      } else if (nextOrder !== 'Cancelled' && stockDeducted === 0) {
        for (const item of getItems(id)) {
          if (!deductStock(item.product_id, item.quantity, now)) fail(409, 'OUT_OF_STOCK', `Not enough stock of "${item.name}" to reopen this order.`);
        }
        stockDeducted = 1;
      }
      db.prepare('UPDATE orders SET order_status = ?, payment_status = ?, stock_deducted = ?, updated_at = ? WHERE id = ?')
        .run(nextOrder, nextPayment, stockDeducted, now, id);
      if (orderChanged) addHistory(id, now, 'orderStatus', order.order_status, nextOrder, note, actor);
      if (paymentChanged) addHistory(id, now, 'paymentStatus', order.payment_status, nextPayment, note, actor);
      bumpRevision(db);
    });
  }
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

async function sendScreenshot(res, orderId) {
  const shot = db.prepare('SELECT * FROM payment_screenshots WHERE order_id = ?').get(orderId);
  if (!shot) notFound('This order has no payment screenshot.');
  let data;
  try {
    data = await fs.promises.readFile(path.join(SCREENSHOT_DIR, path.basename(shot.file_name)));
  } catch (error) {
    if (error.code === 'ENOENT') notFound('The payment screenshot file is missing.');
    throw error;
  }
  // Only a type we validated is ever displayed; an imported file of unknown type is downloaded instead.
  const type = detectFileType(data);
  const ext = type ? type.ext : '';
  const safeId = orderId.replace(/[^A-Za-z0-9_-]/g, '_');
  const disposition = shot.mime === 'application/octet-stream' ? 'attachment' : 'inline';
  res.writeHead(200, {
    'Content-Type': shot.mime,
    'Content-Length': data.length,
    'Content-Disposition': `${disposition}; filename="payment-${safeId}${ext}"`,
    'Content-Security-Policy': SCREENSHOT_CSP,
  });
  res.end(data);
}

// ---------- Notifications ----------

function formatOrderMessage(order, items, hasScreenshot) {
  const lines = [
    'NEW ORDER — Jar of Secrets PK',
    '',
    'CUSTOMER INFORMATION:',
    'Customer Name: ' + order.customer_name,
    'Mobile Number: ' + order.customer_mobile,
    'WhatsApp Number: ' + order.customer_whatsapp,
    'Email: ' + order.customer_email,
    'Complete Address: ' + order.customer_address,
    'City: ' + order.customer_city,
    '',
    'ORDER INFORMATION:',
    'Order ID: ' + order.id,
  ];
  for (const item of items) lines.push(`- ${item.name} x ${item.quantity} — PKR ${item.price} each = PKR ${item.price * item.quantity}`);
  lines.push(
    'Subtotal: PKR ' + order.subtotal,
    'Delivery: PKR ' + order.delivery_fee,
    'Total Amount: PKR ' + order.total,
    '',
    'PAYMENT INFORMATION:',
    'Payment Method: ' + (order.payment_method === 'cod' ? 'Cash on Delivery' : 'Online Bank Transfer'),
    'Payment Status: ' + order.payment_status,
  );
  if (hasScreenshot) lines.push('Payment Screenshot: view or download it in Admin > Orders (login required)');
  if (order.payment_method === 'cod') lines.push(`Cash on Delivery — collect PKR ${order.total} at delivery.`);
  return lines.join('\n');
}

function writeNotificationLog(log) {
  db.prepare(`INSERT INTO notification_logs (id, order_id, channel, recipient, subject, body, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('NTF'), log.orderId, log.channel, log.to, log.subject, log.body, log.status, log.error, new Date().toISOString());
}

async function sendWhatsApp(settings, body) {
  if (!settings.whatsappApiToken || !settings.whatsappPhoneNumberId || !settings.whatsappNumber) {
    return { status: 'skipped', error: 'WhatsApp Cloud API not configured in Admin > Settings (token / phone number ID / admin number missing). Message logged instead.' };
  }
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(settings.whatsappPhoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.whatsappApiToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: settings.whatsappNumber.replace(/[^0-9]/g, ''), type: 'text', text: { body } }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) return { status: 'sent', error: '' };
    return { status: 'failed', error: `WhatsApp API HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` };
  } catch (error) {
    return { status: 'failed', error: String((error && error.message) || error) };
  }
}

/** Runs after the order has committed. A failure here is logged and never reaches the customer. */
async function notifyOrder(order) {
  const settings = getSettings();
  const hasScreenshot = Boolean(db.prepare('SELECT 1 FROM payment_screenshots WHERE order_id = ?').get(order.id));
  const body = formatOrderMessage(order, getItems(order.id), hasScreenshot);

  const whatsapp = await sendWhatsApp(settings, body);
  writeNotificationLog({ orderId: order.id, channel: 'whatsapp', to: settings.whatsappNumber, subject: '', body, ...whatsapp });

  writeNotificationLog({
    orderId: order.id,
    channel: 'email',
    to: settings.notificationEmail,
    subject: `New Order ${order.id} — Jar of Secrets PK`,
    body,
    status: settings.notificationEmail ? 'logged' : 'skipped',
    error: settings.notificationEmail
      ? 'Email body logged. Configure SMTP / a transactional email API to enable automatic sending.'
      : 'Notification email not set in Admin > Settings. Body logged instead.',
  });
}

// ---------- Admin auth ----------

// Used when the username is unknown, so that a wrong username takes as long as a wrong password.
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const DUMMY_HASH = crypto.randomBytes(64).toString('hex');

let setupCode = null;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const hasAdmin = () => Boolean(db.prepare('SELECT 1 FROM admin_users LIMIT 1').get());

function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token).toString('hex'), adminId, now, now + SESSION_TTL);
  return token;
}

function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  return match ? match[1] : '';
}

function requireAdmin(req) {
  const token = bearerToken(req);
  const authRequired = () => fail(401, 'AUTH_REQUIRED', 'Please log in.');
  if (!token) authRequired();
  const tokenHash = sha256(token).toString('hex');
  const session = db.prepare(`SELECT s.expires_at, a.username FROM sessions s JOIN admin_users a ON a.id = s.admin_id WHERE s.token_hash = ?`).get(tokenHash);
  const now = Date.now();
  if (!session) authRequired();
  if (session.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    authRequired();
  }
  // Extending on every poll would mean a disk write every few seconds, so only do it occasionally.
  if (now + SESSION_TTL - session.expires_at >= SESSION_TOUCH_INTERVAL) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_TTL, tokenHash);
  }
  return session;
}

function setupCodeMatches(value) {
  if (typeof value !== 'string' || !setupCode) return false;
  return crypto.timingSafeEqual(sha256(value.trim()), sha256(setupCode));
}

async function adminSetup(req, res, ip) {
  if (hasAdmin()) fail(403, 'SETUP_COMPLETE', 'Setup is already complete. Please log in.');
  if (setupLimiter.count(ip) >= LOGIN_MAX_FAILURES) rateLimited(setupLimiter, ip, 'Too many attempts. Please try again later.');
  const body = await readJson(req);
  if (!setupCodeMatches(body.setupCode)) {
    setupLimiter.hit(ip);
    fail(403, 'BAD_SETUP_CODE', 'That setup code is not correct. It is printed in the server console.');
  }
  const username = textField(body.username, 'Username', { min: 3, max: 64 });
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 1024) invalid('The password must be at least 8 characters.');

  const { salt, hash } = await hashPassword(body.password);
  // The hash is computed outside the transaction, so check again in case another request won the race.
  const admin = tx(db, () => {
    if (hasAdmin()) fail(403, 'SETUP_COMPLETE', 'Setup is already complete. Please log in.');
    const id = newId('ADM');
    db.prepare('INSERT INTO admin_users (id, username, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, username, salt, hash, new Date().toISOString());
    return { id, username };
  });
  setupCode = null;
  sendJSON(res, 201, { token: createSession(admin.id), username: admin.username });
}

async function adminLogin(req, res, ip) {
  if (loginLimiter.count(ip) >= LOGIN_MAX_FAILURES) rateLimited(loginLimiter, ip, 'Too many failed attempts. Please try again later.');
  const body = await readJson(req);
  // Counted before the slow hash, so a burst of parallel guesses cannot slip past the limit. Success clears it.
  loginLimiter.hit(ip);
  const username = typeof body.username === 'string' ? cleanLine(body.username) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const admin = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  const matches = await verifyPassword(password, admin ? admin.salt : DUMMY_SALT, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !matches) fail(401, 'BAD_LOGIN', 'Invalid username or password.');
  loginLimiter.clear(ip);
  sendJSON(res, 200, { token: createSession(admin.id), username: admin.username });
}

function adminLogout(req, res) {
  const token = bearerToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token).toString('hex'));
  sendJSON(res, 200, { ok: true });
}

// ---------- API routing ----------

function applyCors(req, res) {
  if (!ALLOWED_ORIGINS.size) return;
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
}

async function handleApi(req, res, pathname, query) {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const ip = clientIp(req);
  const isAdminPath = pathname === '/api/admin' || pathname.startsWith('/api/admin/');

  if (isAdminPath) return handleAdminApi(req, res, pathname, query, method, ip);

  applyCors(req, res);
  if (method === 'OPTIONS') {
    if (res.hasHeader('Access-Control-Allow-Origin')) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/products' && method === 'GET') {
    const rows = db.prepare('SELECT * FROM products WHERE enabled = 1 ORDER BY rowid').all();
    return sendJSON(res, 200, { products: rows.map(productView) });
  }
  if (pathname === '/api/settings/public' && method === 'GET') {
    const s = getSettings();
    return sendJSON(res, 200, {
      storeName: s.storeName, deliveryCity: s.deliveryCity, deliveryFee: s.deliveryFee,
      cities: deliveryCities(s), onlinePaymentAvailable: onlinePaymentAvailable(s),
    });
  }
  if (pathname === '/api/checkout/bank-details' && method === 'GET') {
    const s = getSettings();
    return sendJSON(res, 200, {
      configured: onlinePaymentAvailable(s), bankName: s.bankName, bankAccountTitle: s.bankAccountTitle,
      bankAccountNumber: s.bankAccountNumber, bankIban: s.bankIban, paymentInstructions: s.paymentInstructions,
    });
  }
  if (pathname === '/api/orders' && method === 'POST') {
    const body = await readJson(req, BODY_LIMIT_ORDER);
    const { status, payload } = createOrder(body, ip);
    return sendJSON(res, status, payload);
  }
  notFound();
}

async function handleAdminApi(req, res, pathname, query, method, ip) {
  // These four are the only admin routes reachable without a session.
  if (pathname === '/api/admin/status' && method === 'GET') {
    const exists = hasAdmin();
    return sendJSON(res, 200, { needsSetup: !exists, hasAdmin: exists });
  }
  if (pathname === '/api/admin/setup' && method === 'POST') return adminSetup(req, res, ip);
  if (pathname === '/api/admin/login' && method === 'POST') return adminLogin(req, res, ip);
  if (pathname === '/api/admin/logout' && method === 'POST') return adminLogout(req, res);

  // Checked before any body is read, so an anonymous client cannot use the larger upload limits.
  const session = requireAdmin(req);

  if (pathname === '/api/admin/sync' && method === 'GET') {
    const latest = db.prepare('SELECT id FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
    return sendJSON(res, 200, { revision: Number(getMeta(db, 'revision')), latestOrderId: latest ? latest.id : null, stats: getStats() });
  }
  if (pathname === '/api/admin/stats' && method === 'GET') return sendJSON(res, 200, { stats: getStats() });

  if (pathname === '/api/admin/products') {
    if (method === 'GET') {
      return sendJSON(res, 200, { products: db.prepare('SELECT * FROM products ORDER BY rowid').all().map(adminProductView) });
    }
    if (method === 'POST') {
      const body = await readJson(req, BODY_LIMIT_PRODUCT);
      return sendJSON(res, 201, { product: adminProductView(createProduct(body)) });
    }
  }
  const productMatch = /^\/api\/admin\/products\/([^/]+)$/.exec(pathname);
  if (productMatch) {
    if (method === 'PUT') {
      const body = await readJson(req, BODY_LIMIT_PRODUCT);
      return sendJSON(res, 200, { product: adminProductView(updateProduct(productMatch[1], body)) });
    }
    if (method === 'DELETE') {
      deleteProduct(productMatch[1]);
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/admin/orders' && method === 'GET') return sendJSON(res, 200, listOrders(query));
  const screenshotMatch = /^\/api\/admin\/orders\/([^/]+)\/screenshot$/.exec(pathname);
  if (screenshotMatch && method === 'GET') return sendScreenshot(res, screenshotMatch[1]);
  const orderMatch = /^\/api\/admin\/orders\/([^/]+)$/.exec(pathname);
  if (orderMatch) {
    if (method === 'GET') {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderMatch[1]);
      if (!order) notFound('Order not found.');
      return sendJSON(res, 200, { order: adminOrderView(order, { withHistory: true }) });
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      const order = updateOrder(orderMatch[1], body, session.username);
      return sendJSON(res, 200, { order: adminOrderView(order, { withHistory: true }) });
    }
  }

  if (pathname === '/api/admin/customers' && method === 'GET') return sendJSON(res, 200, { customers: listCustomers(query) });

  if (pathname === '/api/admin/settings') {
    if (method === 'GET') return sendJSON(res, 200, { settings: adminSettingsView(getSettings()) });
    if (method === 'PUT') {
      const body = await readJson(req);
      updateSettings(body);
      return sendJSON(res, 200, { settings: adminSettingsView(getSettings()) });
    }
  }

  if (pathname === '/api/admin/notifications' && method === 'GET') {
    const rows = db.prepare('SELECT * FROM notification_logs ORDER BY created_at DESC, rowid DESC LIMIT 200').all();
    return sendJSON(res, 200, {
      notifications: rows.map((n) => ({
        id: n.id, orderId: n.order_id, channel: n.channel, to: n.recipient, subject: n.subject, body: n.body,
        status: n.status, error: n.error, createdAt: n.created_at,
      })),
    });
  }
  notFound();
}

// ---------- Static files ----------

async function sendProductImage(req, res, name) {
  let data;
  try {
    data = await fs.promises.readFile(path.join(PRODUCT_IMAGE_DIR, name));
  } catch (error) {
    if (error.code === 'ENOENT') return sendNotFoundPage(res);
    throw error;
  }
  res.writeHead(200, {
    'Content-Type': PRODUCT_IMAGE_TYPES[path.extname(name)],
    'Content-Length': data.length,
    'Cache-Control': 'public, max-age=31536000, immutable', // the file name is random and never reused
  });
  res.end(data);
}

async function sendPublicFile(req, res, pathname) {
  let relative = pathname;
  if (pathname === '/') relative = '/index.html';
  if (pathname === '/admin') relative = '/admin.html';

  const segments = relative.split(/[\\/]+/).filter(Boolean);
  // Dotfiles and "..", plus names Windows would quietly treat as a different file ("a.html.", "a.html::$DATA").
  if (segments.some((s) => s.startsWith('.') || /[:*?"<>|]/.test(s) || /[. ]$/.test(s))) return sendNotFoundPage(res);

  const publicRoot = path.resolve(PUBLIC_DIR);
  const resolved = path.resolve(publicRoot, ...segments);
  if (!resolved.startsWith(publicRoot + path.sep)) return sendNotFoundPage(res);

  let data;
  let realPath;
  try {
    realPath = await fs.promises.realpath(resolved);
    const realRoot = await fs.promises.realpath(publicRoot);
    if (!realPath.startsWith(realRoot + path.sep)) return sendNotFoundPage(res);
    const stat = await fs.promises.stat(realPath);
    if (!stat.isFile()) return sendNotFoundPage(res);
    data = await fs.promises.readFile(realPath);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) return sendNotFoundPage(res);
    throw error;
  }

  const ext = path.extname(realPath).toLowerCase();
  const headers = {
    'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  };
  if (ext === '.html') headers['Content-Security-Policy'] = HTML_CSP;
  if (path.basename(realPath).toLowerCase() === 'admin.html') headers['X-Robots-Tag'] = 'noindex, nofollow';
  res.writeHead(200, headers);
  res.end(data);
}

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }
  // The only route under /uploads. Screenshots are served by the authenticated admin endpoint alone.
  if (pathname.startsWith('/uploads/')) {
    const match = /^\/uploads\/products\/([0-9a-f]{32}\.(?:jpg|png|webp))$/.exec(pathname);
    return match ? sendProductImage(req, res, match[1]) : sendNotFoundPage(res);
  }
  return sendPublicFile(req, res, pathname);
}

// ---------- Server ----------

async function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');

  const url = String(req.url);
  const queryStart = url.indexOf('?');
  const rawPath = queryStart === -1 ? url : url.slice(0, queryStart);
  const isApiPath = (value) => value === '/api' || value.startsWith('/api/');
  if (isApiPath(rawPath)) res.setHeader('Cache-Control', 'no-store');

  if (!rawPath.startsWith('/')) invalid('Bad request path.');
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    invalid('Bad request path.');
  }
  if (pathname.includes('\0')) invalid('Bad request path.');

  if (isApiPath(pathname)) {
    res.setHeader('Cache-Control', 'no-store');
    const query = new URLSearchParams(queryStart === -1 ? '' : url.slice(queryStart + 1));
    return handleApi(req, res, pathname, query);
  }
  return handleStatic(req, res, pathname);
}

function start() {
  try {
    db = openDatabase();
  } catch (error) {
    console.error(`\nThe server did not start.\n${error.message}\n`);
    process.exit(1);
  }

  const purge = () => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    loginLimiter.prune();
    setupLimiter.prune();
    orderLimiter.prune();
  };
  purge();
  setInterval(() => {
    try {
      purge();
    } catch (error) {
      console.error('Scheduled cleanup failed:', error);
    }
  }, 5 * MINUTE).unref();

  if (!hasAdmin()) setupCode = crypto.randomBytes(6).toString('hex').toUpperCase();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => handleError(req, res, error));
  });

  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : error);
    db.close();
    process.exit(1);
  });

  server.listen(PORT, () => {
    const base = `http://localhost:${server.address().port}`;
    console.log('Jar of Secrets PK is running.');
    console.log(`  Store: ${base}/`);
    console.log(`  Admin: ${base}/admin`);
    if (setupCode) {
      console.log('');
      console.log(`  No admin account exists yet. One-time setup code: ${setupCode}`);
      console.log('  Enter it on the Admin page to create the account. It stops working once an admin exists.');
    }
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const finish = () => {
      try {
        db.close();
      } catch (error) {
        console.error('Error closing the database:', error);
      }
      process.exit(0);
    };
    server.close(finish);
    server.closeIdleConnections();
    setTimeout(finish, 3000).unref(); // do not let a stuck connection hold shutdown open
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
