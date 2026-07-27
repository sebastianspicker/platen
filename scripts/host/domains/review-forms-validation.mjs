import { HostError } from '../host-error.mjs';

export const ANNOTATION_TYPES = new Set([
  'comment', 'note', 'callout', 'textMarkup', 'drawingMarkup', 'reference', 'measurement', 'stamp',
]);
export const STATUSES = new Set(['open', 'inProgress', 'resolved', 'rejected', 'custom']);
export const FIELD_TYPES = new Set([
  'text', 'checkbox', 'radio', 'select', 'date', 'number', 'barcode', 'signature',
]);
export const MAX_TEXT = 4_000;
export const MAX_RECORDS = 250;
export const MAX_PAGE = 10_000;
export const MAX_RECT = 1_000_000;
// Deliberately a literal/character-class subset: it cannot express nesting or repetition.
export const SAFE_REGEX = /^\^?(?:[A-Za-z0-9 ._-]|\\[ds]){1,120}\$?$/;

export function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export function json(value) { return JSON.parse(JSON.stringify(value)); }

export function string(value, name, { required = false, max = MAX_TEXT } = {}) {
  if (value == null && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value)) {
    fail('INVALID_INPUT', `${name} must be a bounded printable string.`);
  }
  if (required && !value.trim()) fail('INVALID_INPUT', `${name} is required.`);
  return value;
}

export function id(value, name = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail('INVALID_ID', `${name} must be an opaque bounded identifier.`);
  }
  return value;
}

export function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INPUT', `${name} is out of bounds.`);
  }
  return value;
}

export function date(value, name) {
  string(value, name, { required: true, max: 40 });
  if (Number.isNaN(Date.parse(value))) fail('INVALID_INPUT', `${name} must be an ISO-compatible date.`);
  return value;
}

export function rect(value) {
  const valid = Array.isArray(value) && value.length === 4
    && value.every((number) => Number.isFinite(number) && Math.abs(number) <= MAX_RECT);
  if (!valid) fail('INVALID_RECT', 'rectangle must be four bounded finite numbers.');
  const [x1, y1, x2, y2] = value;
  if (x2 < x1 || y2 < y1) fail('INVALID_RECT', 'rectangle coordinates must be ordered.');
  return [...value];
}

export function escapeXml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

export function csv(value) {
  const text = spreadsheetSafeCsvText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function find(snapshot, namespace, recordId, label = 'record') {
  const record = snapshot.namespaces[namespace].find((item) => item.id === recordId);
  if (!record) fail('NOT_FOUND', `${label} was not found.`, 404);
  return record;
}
import { spreadsheetSafeCsvText } from '../../../src/core/spreadsheet-safe-csv.js';
