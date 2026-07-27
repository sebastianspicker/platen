import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { canonicalizeProjectBundle } from './project-bundle-framing.mjs';

export const REVIEW_SHARED_EXCHANGE_PROFILE = 'local-review-shared-exchange-v1';
export const REVIEW_SHARED_EXCHANGE_SCHEMA_VERSION = 1;
export const REVIEW_SHARED_EXCHANGE_MAX_DELTAS = 500;
export const REVIEW_SHARED_EXCHANGE_MAX_BYTES = 600 * 1024;
export const REVIEW_SHARED_EXCHANGE_MEDIA_TYPE = 'application/vnd.platen.review-exchange+zip';
const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STATUSES = new Set(['open', 'accepted', 'rejected', 'resolved', 'custom']);

function fail(message = 'Review exchange value is invalid.', code = 'INVALID_REVIEW_SHARED_EXCHANGE') { throw new HostError(code, message, 400); }
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) fail(`${label} contains unsupported fields, accessors, or symbols.`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function text(value, label, maximum = 10_000) { if (typeof value !== 'string' || value.length > maximum || value !== value.normalize('NFC') || /[\u0000-\u001f\u007f\ufffd\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) fail(`${label} is not bounded NFC text.`); return value; }
function reviewer(value) { if (typeof value !== 'string' || !REVIEWER.test(value)) fail('reviewerId must be a bounded pseudonymous identifier.'); return value; }
function digest(value, label) { if (!SHA256.test(value ?? '')) fail(`${label} must be a lowercase SHA-256 digest.`); return value; }
function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) fail(`${label} must be a bounded identifier.`); return value; }
function integer(value, label) { if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer.`); return value; }
function timestamp(value, label) { text(value, label, 64); if (Number.isNaN(Date.parse(value))) fail(`${label} must be an ISO timestamp.`); return value; }
function rectangle(value) { const item = exact(value, ['x', 'y', 'width', 'height'], 'rectangle'); for (const key of ['x', 'y', 'width', 'height']) if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || Math.abs(item[key]) > 1_000_000) fail('Review geometry is outside its bound.'); if (item.width <= 0 || item.height <= 0) fail('Review geometry must be positive.'); return Object.freeze(item); }
function properties(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 24) fail('Review properties must be a bounded plain object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) fail('Review properties must be data-only.');
  const out = {}; for (const [key, item] of Object.entries(value)) { id(key, 'property key'); out[key] = text(item, 'property value', 500); } return Object.freeze(out);
}
function mentions(value) {
  if (!Array.isArray(value) || isProxy(value) || value.length > 32 || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length || Object.getPrototypeOf(value) !== Array.prototype) fail('Review mentions must be a bounded array.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => key !== 'length' && (!Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) fail('Review mentions must be data-only.');
  return Object.freeze(value.map((item) => reviewer(item)));
}
function annotationPayload(value) {
  const item = exact(value, ['type', 'page', 'rectangle', 'text', 'status', 'customStatus', 'properties', 'mentions'], 'annotation payload');
  if (!['text', 'highlight', 'underline', 'strikeout', 'square', 'circle', 'line', 'ink', 'freeText', 'comment'].includes(item.type)) fail('Unsupported shared review annotation type.');
  if (!Number.isSafeInteger(item.page) || item.page < 1 || item.page > 10_000) fail('Annotation page is outside its bound.');
  if (!STATUSES.has(item.status)) fail('Annotation status is unsupported.');
  if (item.customStatus !== null) text(item.customStatus, 'customStatus', 80);
  return Object.freeze({ type: item.type, page: item.page, rectangle: rectangle(item.rectangle), text: text(item.text, 'annotation text'), status: item.status, customStatus: item.customStatus === null ? null : item.customStatus, properties: properties(item.properties), mentions: mentions(item.mentions) });
}
function delta(value) {
  const item = exact(value, ['id', 'kind', 'annotationId', 'revision', 'timestamp', 'status', 'authorId', 'text', 'payload', 'sha256'], 'review delta');
  id(item.id, 'delta id');
  if (!['annotation', 'comment'].includes(item.kind)) fail('Review delta kind is unsupported.');
  if (item.kind === 'comment') id(item.annotationId, 'annotationId');
  else if (item.annotationId !== null) fail('Annotation deltas must not carry annotationId.');
  integer(item.revision, 'delta revision');
  timestamp(item.timestamp, 'delta timestamp');
  if (!STATUSES.has(item.status)) fail('Delta status is unsupported.');
  reviewer(item.authorId);
  text(item.text, 'comment text');
  if (item.kind === 'annotation') {
    if (item.payload === null) fail('Annotation delta payload is required.');
    annotationPayload(item.payload);
    if (item.status !== item.payload.status) fail('Annotation delta status must match its payload.');
  } else {
    if (item.status !== 'open') fail('Comment delta status must be open.');
    if (item.payload !== null) fail('Comment delta payload must be null.');
  }
  digest(item.sha256, 'delta sha256');
  const unsigned = { id: item.id, kind: item.kind, annotationId: item.annotationId, revision: item.revision, timestamp: item.timestamp, status: item.status, authorId: item.authorId, text: item.text, payload: item.payload };
  if (createHash('sha256').update(canonicalizeProjectBundle(unsigned), 'utf8').digest('hex') !== item.sha256) fail('Review delta hash does not match its content.');
  return Object.freeze({ ...item, payload: item.payload === null ? null : annotationPayload(item.payload) });
}

export function normalizeReviewSharedExchangeRequest(value, { sourceSha256, currentRevision } = {}) {
  const request = exact(value, ['reviewerId', 'baseRevision'], 'review exchange request'); reviewer(request.reviewerId); integer(request.baseRevision, 'baseRevision'); if (currentRevision !== undefined && request.baseRevision > currentRevision) fail('baseRevision cannot exceed current workspace revision.'); digest(sourceSha256, 'sourceSha256'); return Object.freeze({ reviewerId: request.reviewerId, baseRevision: request.baseRevision, sourceSha256 });
}
export function createReviewSharedExchangeManifest({ sourceSha256, baseRevision, reviewerId, deltas }) {
  digest(sourceSha256, 'sourceSha256'); integer(baseRevision, 'baseRevision'); reviewer(reviewerId); if (!Array.isArray(deltas) || deltas.length > REVIEW_SHARED_EXCHANGE_MAX_DELTAS) fail('Review exchange delta count exceeds its bound.'); const normalized = Object.freeze(deltas.map(delta)); const deltasPayload = { schemaVersion: REVIEW_SHARED_EXCHANGE_SCHEMA_VERSION, deltas: normalized }; const deltasSha256 = createHash('sha256').update(canonicalizeProjectBundle(deltasPayload), 'utf8').digest('hex'); const payload = { profile: REVIEW_SHARED_EXCHANGE_PROFILE, schemaVersion: REVIEW_SHARED_EXCHANGE_SCHEMA_VERSION, sourceSha256, baseRevision, reviewerId, deltaCount: normalized.length, deltasSha256 }; const payloadSha256 = createHash('sha256').update(canonicalizeProjectBundle(payload), 'utf8').digest('hex'); return Object.freeze({ ...payload, payloadSha256 });
}
export function parseReviewSharedExchangeManifest(value) {
  const item = exact(value, ['baseRevision', 'deltaCount', 'deltasSha256', 'payloadSha256', 'profile', 'reviewerId', 'schemaVersion', 'sourceSha256'], 'review exchange manifest');
  if (item.profile !== REVIEW_SHARED_EXCHANGE_PROFILE || item.schemaVersion !== REVIEW_SHARED_EXCHANGE_SCHEMA_VERSION) fail('Review exchange manifest version is unsupported.');
  digest(item.sourceSha256, 'sourceSha256'); reviewer(item.reviewerId); integer(item.baseRevision, 'baseRevision');
  if (!Number.isSafeInteger(item.deltaCount) || item.deltaCount < 0 || item.deltaCount > REVIEW_SHARED_EXCHANGE_MAX_DELTAS) fail('Review exchange delta count is outside its bound.');
  digest(item.deltasSha256, 'deltasSha256'); digest(item.payloadSha256, 'payloadSha256');
  const payload = { profile: item.profile, schemaVersion: item.schemaVersion, sourceSha256: item.sourceSha256, baseRevision: item.baseRevision, reviewerId: item.reviewerId, deltaCount: item.deltaCount, deltasSha256: item.deltasSha256 };
  if (createHash('sha256').update(canonicalizeProjectBundle(payload), 'utf8').digest('hex') !== item.payloadSha256) fail('Review exchange manifest hash does not match its content.');
  return Object.freeze(item);
}
export function parseReviewSharedExchangeDeltas(value, manifest) {
  const item = exact(value, ['deltas', 'schemaVersion'], 'review exchange deltas');
  if (item.schemaVersion !== REVIEW_SHARED_EXCHANGE_SCHEMA_VERSION || !Array.isArray(item.deltas) || isProxy(item.deltas) || Object.keys(item.deltas).length !== item.deltas.length || item.deltas.length !== manifest.deltaCount || item.deltas.length > REVIEW_SHARED_EXCHANGE_MAX_DELTAS) fail('Review exchange deltas are invalid.');
  const descriptors = Object.getOwnPropertyDescriptors(item.deltas);
  if (Reflect.ownKeys(item.deltas).some((key) => key !== 'length' && (!Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) fail('Review exchange deltas must be data-only.');
  const deltas = Object.freeze(item.deltas.map(delta));
  const digestValue = createHash('sha256').update(canonicalizeProjectBundle({ schemaVersion: item.schemaVersion, deltas }), 'utf8').digest('hex');
  if (digestValue !== manifest.deltasSha256) fail('Review exchange delta hash does not match the manifest.');
  return deltas;
}
export const reviewSharedExchangeDigest = (value) => createHash('sha256').update(canonicalizeProjectBundle(value), 'utf8').digest('hex');
