import { PlatenError } from './errors.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const REDACTION_OVERLAY_LABEL_PROFILE = 'local-object-full-page-redaction-overlay-label-v1';
export const REDACTION_OVERLAY_LABEL_LIMITATIONS = Object.freeze([
  'Only one full-page redaction target and one 1–40 character FreeText annotation label are supported in the bounded classic passive PDF subset.',
  'The label is stored as annotation contents; appearance rendering, fill, color, code sets, positioning controls, and region redaction are not claimed.',
  'The operation retains a separate artifact and leaves the source unchanged; it is not whole-document sanitization or conformance/signature preservation.',
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_KEYS = Object.freeze(['profile', 'sourceSha256', 'page', 'label']);
const RESULT_KEYS = Object.freeze([
  'kind', 'profile', 'documentId', 'sourceSha256', 'page', 'label',
  'labelContentsSha256', 'artifact', 'evidence', 'limitations',
]);
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourceUnchanged', 'fullPageContentRemoved',
  'closedRedactionBase', 'labelAnnotationStored', 'labelContentsDigestBound',
  'artifactDigestBound', 'localOnly',
]);
const ARTIFACT_KEYS = Object.freeze([
  'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation',
  'createdAt',
]);
const OPERATION_KEYS = Object.freeze([
  'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation',
  'completedAt',
]);

function invalid(message) {
  throw new TypeError(`Redaction overlay-label contract is invalid: ${message}`);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)) {
    invalid(`${label} has an unsupported shape.`);
  }
  return value;
}

function snapshot(value, state, depth = 0) {
  state.items += 1;
  if (state.items > 4_000 || depth > 12) invalid('input exceeds structural limits.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('input contains a non-finite number.');
    return value;
  }
  if (typeof value === 'string') {
    state.bytes += new TextEncoder().encode(value).byteLength;
    if (state.bytes > 2 * 1024 * 1024) invalid('input contains oversized text.');
    return value;
  }
  if (!value || typeof value !== 'object' || state.active.has(value)) {
    invalid('input must be acyclic plain data.');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    invalid('input contains a hostile object.');
  }
  if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) invalid('input contains an exotic object.');
  const keys = Reflect.ownKeys(descriptors);
  state.active.add(value);
  let copied;
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 256
      || !descriptors.length || !('value' in descriptors.length)
      || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)))) {
      invalid('arrays must be dense data arrays.');
    }
    const expected = Array.from({ length }, (_, index) => String(index));
    const actual = keys.filter((key) => key !== 'length');
    if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(descriptors, key)
      || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)) invalid('arrays must be dense data arrays.');
    copied = expected.map((key) => snapshot(descriptors[key].value, state, depth + 1));
  } else {
    if (keys.some((key) => typeof key !== 'string' || !('value' in descriptors[key])
      || descriptors[key].enumerable !== true)) invalid('objects must contain enumerable data properties.');
    copied = {};
    for (const key of keys) Object.defineProperty(copied, key, {
      value: snapshot(descriptors[key].value, state, depth + 1), enumerable: true, writable: true, configurable: true,
    });
  }
  state.active.delete(value);
  return copied;
}

function snapshotJson(value) {
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) invalid('inherited JSON hooks are not allowed.');
  return snapshot(value, { active: new Set(), items: 0, bytes: 0 });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validLabel(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 40
    && value === value.normalize('NFC')
    && !/[\u0000-\u001f\u007f-\u009f\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u.test(value)
    && !value.includes('/') && !value.includes('\\');
}

export function normalizeRedactionOverlayLabelRequest(value) {
  let copied;
  try { copied = snapshotJson(value); } catch { invalid('request must contain safe plain data.'); }
  exact(copied, REQUEST_KEYS, 'request');
  if (copied.profile !== REDACTION_OVERLAY_LABEL_PROFILE || !SHA256.test(copied.sourceSha256 ?? '')
    || !Number.isSafeInteger(copied.page) || copied.page < 1 || copied.page > 100 || !validLabel(copied.label)) {
    invalid('request identity or bounds are invalid.');
  }
  return deepFreeze({
    profile: REDACTION_OVERLAY_LABEL_PROFILE,
    sourceSha256: copied.sourceSha256,
    page: copied.page,
    label: copied.label,
  });
}

function canonicalTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validArtifact(artifact, context) {
  return exact(artifact, ARTIFACT_KEYS, 'artifact')
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId
    && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && artifact.displayName === artifact.displayName.normalize('NFC')
    && !/[\u0000-\u001f\u007f-\u009f\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u.test(artifact.displayName)
    && !artifact.displayName.includes('/') && !artifact.displayName.includes('\\')
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64 && artifact.size <= 129 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256
    && canonicalTimestamp(artifact.createdAt);
}

function validOperation(operation, artifact, context, labelDigest) {
  if (!exact(operation, OPERATION_KEYS, 'artifact.operation') || operation.schemaVersion !== 1
    || !OPAQUE_ID_PATTERN.test(operation.id ?? '') || operation.type !== 'pdf-redaction-overlay-label'
    || !Array.isArray(operation.inputs) || operation.inputs.length !== 1
    || !exact(operation.inputs[0], ['documentId', 'sha256', 'role'], 'operation input')
    || operation.inputs[0].documentId !== context.documentId || operation.inputs[0].sha256 !== context.sourceSha256
    || operation.inputs[0].role !== 'source'
    || !exact(operation.parameters, ['profile', 'page', 'labelContentsSha256'], 'operation parameters')
    || operation.parameters.profile !== REDACTION_OVERLAY_LABEL_PROFILE
    || operation.parameters.page !== context.request.page || operation.parameters.labelContentsSha256 !== labelDigest
    || !exact(operation.expected, ['sourceUnchanged', 'fullPageContentRemoved', 'labelAnnotationStored'], 'operation expected')
    || operation.expected.sourceUnchanged !== true || operation.expected.fullPageContentRemoved !== true
    || operation.expected.labelAnnotationStored !== true
    || !operation.validation || typeof operation.validation !== 'object' || Array.isArray(operation.validation)
    || Object.getPrototypeOf(operation.validation) !== Object.prototype
    || !Object.hasOwn(operation.validation, 'passed') || operation.validation.passed !== true
    || !Object.hasOwn(operation.validation, 'outputSha256') || operation.validation.outputSha256 !== artifact.sha256
    || !Array.isArray(operation.validation.validators) || operation.validation.validators.length < 1
    || operation.validation.validators.length > 64
    || operation.validation.validators.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 128
      || /[\u0000-\u001f\u007f-\u009f\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}/\\]/u.test(entry)) || !canonicalTimestamp(operation.completedAt)) return false;
  return true;
}

function invalidResult() {
  throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid source-bound redaction overlay-label result.');
}

export function validateRedactionOverlayLabelResult(value, context = {}) {
  let copied;
  try { copied = snapshotJson(value); } catch { invalidResult(); }
  const request = context.request;
  if (!request || request.profile !== REDACTION_OVERLAY_LABEL_PROFILE
    || request.sourceSha256 !== context.sourceSha256 || !SHA256.test(context.sourceSha256 ?? '')
    || !Number.isSafeInteger(request.page) || request.page < 1 || request.page > 100
    || !validLabel(request.label) || !OPAQUE_ID_PATTERN.test(context.documentId ?? '')) invalidResult();
  try {
    if (!exact(copied, RESULT_KEYS, 'result') || copied.kind !== 'pdf-redaction-overlay-label'
      || copied.profile !== REDACTION_OVERLAY_LABEL_PROFILE || copied.documentId !== context.documentId
      || copied.sourceSha256 !== context.sourceSha256 || copied.page !== request.page || copied.label !== request.label
      || !SHA256.test(copied.labelContentsSha256 ?? '')
      || !validArtifact(copied.artifact, context) || !exact(copied.evidence, EVIDENCE_KEYS, 'evidence')
      || EVIDENCE_KEYS.some((key) => copied.evidence[key] !== true)
      || !Array.isArray(copied.limitations) || copied.limitations.length !== REDACTION_OVERLAY_LABEL_LIMITATIONS.length
      || copied.limitations.some((entry, index) => entry !== REDACTION_OVERLAY_LABEL_LIMITATIONS[index])
      || !validOperation(copied.artifact.operation, copied.artifact, context, copied.labelContentsSha256)) invalidResult();
  } catch (error) {
    if (error?.code === 'INVALID_LOCAL_HOST') throw error;
    invalidResult();
  }
  return deepFreeze(copied);
}

export function validateRedactionOverlayLabelResponse(body, context) {
  let copied;
  try { copied = snapshotJson(body); } catch { invalidResult(); }
  try { exact(copied, ['result'], 'response'); } catch { invalidResult(); }
  return validateRedactionOverlayLabelResult(copied.result, context);
}
