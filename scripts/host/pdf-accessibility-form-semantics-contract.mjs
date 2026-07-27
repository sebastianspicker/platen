import { isProxy } from 'node:util/types';

export const PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE = 'local-accessibility-form-semantics-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const ROLES = new Set(['text', 'button', 'choice']);
const MAX_FIELDS = 50;
const MAX_TEXT = 127;

function invalid(message = 'Accessible form semantics request is invalid.') {
  const error = new Error(message); error.code = 'INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS'; return error;
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || Object.values(descriptors).some((descriptor) => descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'))) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function text(value, label, optional = false) {
  if (optional && value === '') return '';
  if (typeof value !== 'string' || (!optional && value.length < 1) || value.length > MAX_TEXT
    || value !== value.normalize('NFC') || value.trim() !== value || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) throw invalid(`${label} must be bounded NFC text.`);
  return value;
}
function locator(value) {
  const target = exact(value, ['page', 'annotationIndex', 'fingerprint']);
  if (!Number.isSafeInteger(target.page) || target.page < 1 || target.page > 10_000
    || !Number.isSafeInteger(target.annotationIndex) || target.annotationIndex < 0 || target.annotationIndex >= 50
    || !SHA256.test(target.fingerprint ?? '')) throw invalid('field target is invalid.');
  return Object.freeze({ page: target.page, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint });
}
function field(value) {
  const item = exact(value, ['target', 'role', 'name', 'tooltip', 'tabIndex']);
  if (!ROLES.has(item.role) || !Number.isSafeInteger(item.tabIndex) || item.tabIndex < 0 || item.tabIndex >= MAX_FIELDS) throw invalid('field role or tabIndex is invalid.');
  return Object.freeze({ target: locator(item.target), role: item.role, name: text(item.name, 'name'), tooltip: text(item.tooltip, 'tooltip', true), tabIndex: item.tabIndex });
}
function fieldsArray(value) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid('fields must be a dense data-only array.');
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value); const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FIELDS || keys.length !== length + 1
    || keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^\d+$/u.test(key)))
    || !Object.hasOwn(descriptors.length, 'value') || Object.entries(descriptors).some(([key, descriptor]) => key !== 'length' && (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true))) throw invalid('fields must be a dense data-only array.');
  for (let index = 0; index < length; index += 1) if (!Object.hasOwn(descriptors, String(index))) throw invalid('fields must be dense.');
  return Array.from({ length }, (_, index) => descriptors[index].value);
}
export function normalizePdfAccessibilityFormSemantics(value) {
  const request = exact(value, ['profile', 'sourceSha256', 'fields']);
  if (request.profile !== PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE || !SHA256.test(request.sourceSha256 ?? '')
    || !Array.isArray(request.fields) || request.fields.length < 1 || request.fields.length > MAX_FIELDS) throw invalid();
  const fields = fieldsArray(request.fields).map(field); const indexes = new Set(); const targets = new Set();
  for (const item of fields) { if (indexes.has(item.tabIndex)) throw invalid('tabIndex values must be unique.'); indexes.add(item.tabIndex); const key = `${item.target.page}:${item.target.annotationIndex}`; if (targets.has(key)) throw invalid('field targets must be unique.'); targets.add(key); }
  return Object.freeze({ profile: PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE, sourceSha256: request.sourceSha256, fields: Object.freeze(fields) });
}
export const ACCESSIBILITY_FORM_SEMANTICS_LIMITS = Object.freeze({ maxFields: MAX_FIELDS, maxText: MAX_TEXT });
