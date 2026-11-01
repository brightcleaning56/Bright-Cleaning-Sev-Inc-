'use strict';

const crypto = require('crypto');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Money is always rounded to whole cents, half away from zero.
function money(value) {
  const n = Number(value);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositive(v) {
  return isFiniteNumber(v) && v > 0;
}

function isNonNegative(v) {
  return isFiniteNumber(v) && v >= 0;
}

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.details = details || [];
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message || 'Not found');
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

module.exports = {
  newId,
  sha256,
  hmac,
  safeEqual,
  escapeHtml,
  money,
  isFiniteNumber,
  isPositive,
  isNonNegative,
  normEmail,
  isEmail,
  ValidationError,
  NotFoundError,
  ConflictError,
};
