import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE,
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE,
  AUTOMATION_PRESET_IDS,
  OPAQUE_ID,
  SHA256,
} from './automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_IDS, AUTOMATION_SEQUENCE_TYPE } from './automation-sequence-contract.mjs';

export const AUTOMATION_API_SCHEMA_VERSION = 1;
export const AUTOMATION_API_MAX_POLL_MS = 10_000;
export const AUTOMATION_API_MAX_IDEMPOTENCY_KEY_BYTES = 256;
export const AUTOMATION_API_CAPABILITIES = Object.freeze([
  'automation.submit',
  'automation.status',
  'automation.output',
  'automation.cancel',
]);

export const AUTOMATION_OPERATION_IDS = Object.freeze([
  AUTOMATION_FULL_PAGE_REDACTION_TYPE,
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE,
]);

const PRINCIPAL = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const GRANT_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const CAPABILITY = new Set(AUTOMATION_API_CAPABILITIES);
const OPERATIONS = new Set(AUTOMATION_OPERATION_IDS);
const PRESETS = new Set(AUTOMATION_PRESET_IDS);
const SEQUENCES = new Set(AUTOMATION_SEQUENCE_IDS);
const FORBIDDEN_KEYS = /(?:path|bytes|secret|password|token|stream|buffer|content|private)/iu;
const MAGIC_RECEIPT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SELECTIONS = Object.freeze({ operation: OPERATIONS, preset: PRESETS, sequence: SEQUENCES });
const SELECTION_DENIAL_MESSAGES = Object.freeze({
  operation: 'Automation API operation is not allowlisted.',
  preset: 'Automation API preset is not allowlisted.',
  sequence: 'Automation API sequence is not allowlisted.',
});

export function apiFail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function isPlainDataObject(value) {
  if (value === null) return false;
  if (typeof value !== 'object') return false;
  if (nodeTypes.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function ownDescriptors(value) {
  try { return Object.getOwnPropertyDescriptors(value); } catch { return null; }
}

function isEnumerableDataDescriptor(descriptors, key) {
  if (!Object.hasOwn(descriptors, key)) return false;
  const descriptor = descriptors[key];
  if (!Object.hasOwn(descriptor, 'value')) return false;
  return descriptor.enumerable === true;
}

function hasExactDataKeys(descriptors, actual, keys) {
  if (actual.length !== keys.length) return false;
  for (const key of actual) {
    if (typeof key !== 'string') return false;
    if (!keys.includes(key)) return false;
    if (!isEnumerableDataDescriptor(descriptors, key)) return false;
  }
  return true;
}

function exact(value, keys, label) {
  if (!isPlainDataObject(value)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', `${label} must be a plain object.`);
  }
  const descriptors = ownDescriptors(value);
  const actual = descriptors ? Reflect.ownKeys(value) : [];
  if (!descriptors) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', `${label} contains unsupported fields, accessors, or symbols.`);
  }
  if (!hasExactDataKeys(descriptors, actual, keys)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', `${label} contains unsupported fields, accessors, or symbols.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function principal(value) {
  if (typeof value !== 'string') {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API principal is invalid.');
  }
  if (!PRINCIPAL.test(value)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API principal is invalid.');
  }
  return value;
}

function grant(value) {
  const item = exact(value, ['grantId', 'principal'], 'capability grant');
  if (typeof item.grantId !== 'string') {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API capability grant is invalid.');
  }
  if (!GRANT_ID.test(item.grantId)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API capability grant is invalid.');
  }
  principal(item.principal);
  return item;
}

function source(value) {
  const item = exact(value, ['id', 'sha256'], 'automation source');
  if (typeof item.id !== 'string') {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API source binding is invalid.');
  }
  if (!OPAQUE_ID.test(item.id ?? '')) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API source binding is invalid.');
  }
  if (typeof item.sha256 !== 'string') {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API source binding is invalid.');
  }
  if (!SHA256.test(item.sha256 ?? '')) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API source binding is invalid.');
  }
  return Object.freeze({ id: item.id, sha256: item.sha256 });
}

function idempotencyKey(value) {
  if (typeof value !== 'string') {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API idempotency key is invalid.');
  }
  if (value.length < 1) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API idempotency key is invalid.');
  }
  if (Buffer.byteLength(value, 'utf8') > AUTOMATION_API_MAX_IDEMPOTENCY_KEY_BYTES) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API idempotency key is invalid.');
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API idempotency key is invalid.');
  }
  return value;
}

function isDataArray(value) {
  if (nodeTypes.isProxy(value)) return false;
  return Array.isArray(value);
}

function isArrayLengthWithin(value, minimum, maximum) {
  if (value.length < minimum) return false;
  return value.length <= maximum;
}

function hasExpectedArrayOwnKeys(value) {
  if (Object.keys(value).length !== value.length) return false;
  return Object.getOwnPropertySymbols(value).length === 0;
}

function hasArrayLengthDescriptor(descriptors, length) {
  if (!Object.hasOwn(descriptors, 'length')) return false;
  const descriptor = descriptors.length;
  if (!Object.hasOwn(descriptor, 'value')) return false;
  if (descriptor.enumerable !== false) return false;
  if (descriptor.configurable !== false) return false;
  return descriptor.value === length;
}

function hasDenseDataOnlyArrayEntries(value, descriptors) {
  if (!hasArrayLengthDescriptor(descriptors, value.length)) return false;
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!isEnumerableDataDescriptor(descriptors, String(index))) return false;
  }
  return true;
}

function arrayValues(value, descriptors) {
  return Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value);
}

function requireDataArray(value, minimum, maximum, code, status, invalidMessage, denseMessage) {
  if (!isDataArray(value)) apiFail(code, invalidMessage, status);
  if (!isArrayLengthWithin(value, minimum, maximum)) apiFail(code, invalidMessage, status);
  const descriptors = ownDescriptors(value);
  if (!descriptors) {
    apiFail(code, denseMessage, status);
  }
  if (!hasDenseDataOnlyArrayEntries(value, descriptors)) {
    apiFail(code, denseMessage, status);
  }
  return descriptors;
}

function pages(value) {
  if (!isDataArray(value)) apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API redaction pages are invalid.');
  if (!hasExpectedArrayOwnKeys(value)) apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API redaction pages are invalid.');
  const descriptors = requireDataArray(
    value, 1, 100, 'INVALID_AUTOMATION_API_REQUEST', 400,
    'Automation API redaction pages are invalid.',
    'Automation API redaction pages must be dense data-only values.',
  );
  let previous = 0;
  const result = arrayValues(value, descriptors).map((page) => {
    if (!Number.isSafeInteger(page)) {
      apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API redaction pages must ascend within the fixed bound.');
    }
    if (page < 1) {
      apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API redaction pages must ascend within the fixed bound.');
    }
    if (page > 100) {
      apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API redaction pages must ascend within the fixed bound.');
    }
    if (page <= previous) {
      apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API redaction pages must ascend within the fixed bound.');
    }
    previous = page;
    return page;
  });
  return Object.freeze(result);
}

function selectionKind(value) {
  if (typeof value !== 'string') return null;
  if (!Object.hasOwn(SELECTIONS, value)) return null;
  return value;
}

function isFullPageRedaction(item) {
  if (item.kind !== 'operation') return false;
  return item.id === AUTOMATION_FULL_PAGE_REDACTION_TYPE;
}

function validatedSelectionPages(kind, id, value) {
  if (isFullPageRedaction({ kind, id })) {
    return pages(value);
  }
  if (value !== null) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Pages are only accepted by full-page redaction.');
  }
  return null;
}

function selection(value) {
  const item = exact(value, ['id', 'kind', 'pages'], 'automation operation selection');
  const kind = selectionKind(item.kind);
  if (kind === null) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API operation selection is invalid.');
  }
  if (typeof item.id !== 'string') {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API operation selection is invalid.');
  }
  if (item.id.length > 128) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API operation selection is invalid.');
  }
  if (!SELECTIONS[kind].has(item.id)) {
    apiFail('AUTOMATION_API_OPERATION_DENIED', SELECTION_DENIAL_MESSAGES[kind], 403);
  }
  return Object.freeze({ kind, id: item.id, pages: validatedSelectionPages(kind, item.id, item.pages) });
}

export function normalizeAutomationApiSubmitRequest(value) {
  const item = exact(value, ['grant', 'idempotencyKey', 'operation', 'principal', 'source'], 'automation API submit request');
  const caller = principal(item.principal);
  const capabilityGrant = grant(item.grant);
  if (capabilityGrant.principal !== caller) apiFail('AUTOMATION_API_GRANT_MISMATCH', 'Capability grant principal does not match the caller.', 403);
  return Object.freeze({
    schemaVersion: AUTOMATION_API_SCHEMA_VERSION,
    principal: caller,
    grant: capabilityGrant,
    source: source(item.source),
    operation: selection(item.operation),
    idempotencyKey: idempotencyKey(item.idempotencyKey),
  });
}

function normalizeJobRequest(value, action) {
  const item = exact(value, ['grant', 'jobId', 'principal'], `automation API ${action} request`);
  const caller = principal(item.principal);
  const capabilityGrant = grant(item.grant);
  if (capabilityGrant.principal !== caller) apiFail('AUTOMATION_API_GRANT_MISMATCH', 'Capability grant principal does not match the caller.', 403);
  if (typeof item.jobId !== 'string') apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API job ID is invalid.');
  if (!OPAQUE_ID.test(item.jobId ?? '')) apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API job ID is invalid.');
  return Object.freeze({ schemaVersion: AUTOMATION_API_SCHEMA_VERSION, principal: caller, grant: capabilityGrant, jobId: item.jobId });
}

export function normalizeAutomationApiStatusRequest(value) { return normalizeJobRequest(value, 'status'); }
export function normalizeAutomationApiCancelRequest(value) { return normalizeJobRequest(value, 'cancel'); }

export function normalizeAutomationApiPollRequest(value) {
  const item = exact(value, ['grant', 'jobId', 'maxWaitMs', 'principal'], 'automation API poll request');
  const base = normalizeJobRequest({ grant: item.grant, jobId: item.jobId, principal: item.principal }, 'poll');
  if (!Number.isSafeInteger(item.maxWaitMs)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API poll timeout is outside the fixed bound.');
  }
  if (item.maxWaitMs < 0) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API poll timeout is outside the fixed bound.');
  }
  if (item.maxWaitMs > AUTOMATION_API_MAX_POLL_MS) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API poll timeout is outside the fixed bound.');
  }
  return Object.freeze({ ...base, maxWaitMs: item.maxWaitMs });
}

export function normalizeAutomationApiOutputRequest(value) {
  const item = exact(value, ['grant', 'jobId', 'outputId', 'outputSha256', 'principal'], 'automation API output request');
  const caller = principal(item.principal);
  const capabilityGrant = grant(item.grant);
  if (capabilityGrant.principal !== caller) apiFail('AUTOMATION_API_GRANT_MISMATCH', 'Capability grant principal does not match the caller.', 403);
  if (typeof item.jobId !== 'string') apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API job ID is invalid.');
  if (!OPAQUE_ID.test(item.jobId ?? '')) apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API job ID is invalid.');
  if (typeof item.outputId !== 'string') apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API output binding is invalid.');
  if (!OPAQUE_ID.test(item.outputId ?? '')) apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API output binding is invalid.');
  if (typeof item.outputSha256 !== 'string') apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API output binding is invalid.');
  if (!SHA256.test(item.outputSha256 ?? '')) apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API output binding is invalid.');
  return Object.freeze({ schemaVersion: AUTOMATION_API_SCHEMA_VERSION, principal: caller, grant: capabilityGrant, jobId: item.jobId, outputId: item.outputId, outputSha256: item.outputSha256 });
}

export function requiredCapability(action) {
  const value = `automation.${action}`;
  if (!CAPABILITY.has(value)) throw new Error('Unsupported automation API action.');
  return value;
}

function canCopyReceiptObject(item, seen) {
  if (!isPlainDataObject(item)) return false;
  return !seen.has(item);
}

function shouldOmitReceiptKey(key) {
  if (typeof key !== 'string') return true;
  if (MAGIC_RECEIPT_KEYS.has(key)) return true;
  // This is a privacy sanitizer, not a receipt schema; non-sensitive fields such as location remain public.
  return FORBIDDEN_KEYS.test(key);
}

function copyPublicReceiptArray(item, depth, seen) {
  if (seen.has(item)) apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt is invalid.', 502);
  seen.add(item);
  const descriptors = requireDataArray(
    item, 0, 500, 'AUTOMATION_API_RESULT_INVALID', 502,
    'Automation API receipt array is invalid.',
    'Automation API receipt array must be dense data-only values.',
  );
  const copied = Object.freeze(arrayValues(item, descriptors).map((entry) => copyPublicReceipt(entry, depth + 1, seen)));
  seen.delete(item);
  return copied;
}

function copyPublicReceiptObject(item, depth, seen) {
  if (!canCopyReceiptObject(item, seen)) apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt is invalid.', 502);
  seen.add(item);
  const descriptors = Object.getOwnPropertyDescriptors(item);
  const out = {};
  for (const key of Reflect.ownKeys(item)) {
    if (shouldOmitReceiptKey(key)) continue;
    if (!isEnumerableDataDescriptor(descriptors, key)) apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt contains an accessor.', 502);
    Object.defineProperty(out, key, {
      configurable: true,
      enumerable: true,
      value: copyPublicReceipt(descriptors[key].value, depth + 1, seen),
      writable: true,
    });
  }
  seen.delete(item);
  return Object.freeze(out);
}

function copyPublicReceipt(item, depth, seen) {
  if (depth > 8) apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt is too deep.', 502);
  if (nodeTypes.isProxy(item)) apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt is invalid.', 502);
  if (item === null) return item;
  if (typeof item === 'string') return item;
  if (typeof item === 'boolean') return item;
  if (typeof item === 'number') return Number.isFinite(item) ? item : null;
  if (Array.isArray(item)) return copyPublicReceiptArray(item, depth, seen);
  return copyPublicReceiptObject(item, depth, seen);
}

export function publicAutomationApiReceipt(value) {
  return copyPublicReceipt(value, 0, new Set());
}

export const automationApiCapabilityGrant = (grantId, principalId) => Object.freeze({ grantId, principal: principalId });
