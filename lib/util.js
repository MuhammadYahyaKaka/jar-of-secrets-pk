/**
 * Small helpers shared by server.js, lib/db.js and scripts/.
 */
'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// ---------- IDs ----------

/** Order ids keep the original JOS-<base36 time>-<4 digits> format. Callers retry on collision. */
function newOrderId() {
  return `JOS-${Date.now().toString(36).toUpperCase()}-${crypto.randomInt(1000, 10000)}`;
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Random name for an uploaded file: 32 hex characters plus the detected extension. */
function randomFileName(ext) {
  return crypto.randomBytes(16).toString('hex') + ext;
}

// ---------- Files ----------

/** Decodes base64 (with an optional data: prefix) strictly. Returns a Buffer, or null if malformed. */
function decodeBase64Strict(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/^data:[^,]{0,100};base64,/, '');
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const buffer = Buffer.from(text, 'base64');
  // The round trip rejects non-canonical input that Buffer.from would otherwise quietly accept.
  return buffer.toString('base64') === text ? buffer : null;
}

/** Identifies a file by its magic bytes. Returns { kind, mime, ext }, or null if not recognised. */
function detectFileType(buffer) {
  const starts = (bytes, offset = 0) =>
    buffer.length >= offset + bytes.length && bytes.every((b, i) => buffer[offset + i] === b);
  if (starts([0xff, 0xd8, 0xff])) return { kind: 'jpeg', mime: 'image/jpeg', ext: '.jpg' };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'png', mime: 'image/png', ext: '.png' };
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'pdf', mime: 'application/pdf', ext: '.pdf' };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { kind: 'webp', mime: 'image/webp', ext: '.webp' };
  return null;
}

// ---------- Customers ----------

/**
 * One customer per normalised mobile: strip formatting, then write Pakistani numbers one way, so that
 * "+92 300 1234567", "0092 300 1234567" and "0300-1234567" are the same person.
 */
function normalizeMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^92\d{10}$/.test(digits)) return '0' + digits.slice(2);
  if (/^0092\d{10}$/.test(digits)) return '0' + digits.slice(4);
  if (/^3\d{9}$/.test(digits)) return '0' + digits;
  return digits;
}

// ---------- Passwords (same scrypt parameters as the original server, so old hashes still verify) ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { salt, hash };
}

async function verifyPassword(password, salt, expectedHex) {
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { newOrderId, newId, randomFileName, decodeBase64Strict, detectFileType, normalizeMobile, hashPassword, verifyPassword };
