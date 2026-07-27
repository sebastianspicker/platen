import { createHash } from 'node:crypto';
import { createBlankPdf, createTextPdf } from '../pdf-factory.mjs';
import { HostError } from '../host-error.mjs';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function result(capabilityId, payload = {}) {
  return Object.freeze({
    kind: 'professional-capability-result',
    schemaVersion: 1,
    capabilityId,
    ok: true,
    localOnly: true,
    ...payload,
  });
}

export function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

export function requireString(value, label, { min = 1, max = 10_000 } = {}) {
  if (typeof value !== 'string') fail('INVALID_PROFESSIONAL_INPUT', `${label} must be a string.`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.length < min || normalized.length > max) {
    fail('INVALID_PROFESSIONAL_INPUT', `${label} length must be from ${min} through ${max}.`);
  }
  return normalized;
}

export function requireBytes(value, label, { min = 5, max = 64 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail('INVALID_PROFESSIONAL_INPUT', `${label} must be PDF bytes.`);
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length < min || bytes.length > max) {
    fail('INVALID_PROFESSIONAL_INPUT', `${label} size is outside professional bounds.`);
  }
  return bytes;
}

export function blankPdf(options = {}) {
  return createBlankPdf({ pages: 1, widthPoints: 612, heightPoints: 792, title: 'Professional fixture', ...options });
}

export function textPdf(text, options = {}) {
  return createTextPdf({ text, widthPoints: 612, heightPoints: 792, title: 'Professional text fixture', ...options });
}

export function sourceBound(bytes) {
  const source = requireBytes(bytes, 'sourcePdf');
  return { source, sourceSha256: sha256(source) };
}

/** Minimal classic PDF with one page and optional content stream text. */
export function classicOnePagePdf({ text = 'fixture', width = 612, height = 792 } = {}) {
  return createTextPdf({ text, widthPoints: width, heightPoints: height, title: 'classic-one-page' });
}
