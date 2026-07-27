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

export function apiFail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', `${label} must be a plain object.`);
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { descriptors = null; }
  const actual = descriptors ? Reflect.ownKeys(value) : [];
  if (!descriptors || actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key)
      || !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value')
      || descriptors[key].enumerable !== true)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', `${label} contains unsupported fields, accessors, or symbols.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL.test(value)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API principal is invalid.');
  }
  return value;
}

function grant(value) {
  const item = exact(value, ['grantId', 'principal'], 'capability grant');
  if (typeof item.grantId !== 'string' || !GRANT_ID.test(item.grantId)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API capability grant is invalid.');
  }
  principal(item.principal);
  return item;
}

function source(value) {
  const item = exact(value, ['id', 'sha256'], 'automation source');
  if (!OPAQUE_ID.test(item.id ?? '') || !SHA256.test(item.sha256 ?? '')) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API source binding is invalid.');
  }
  return Object.freeze({ id: item.id, sha256: item.sha256 });
}

function idempotencyKey(value) {
  if (typeof value !== 'string' || value.length < 1
    || Buffer.byteLength(value, 'utf8') > AUTOMATION_API_MAX_IDEMPOTENCY_KEY_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API idempotency key is invalid.');
  }
  return value;
}

function pages(value) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.keys(value).length !== value.length
    || Object.getOwnPropertySymbols(value).length > 0
    || value.length < 1 || value.length > 100) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API redaction pages are invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some((key) => key !== 'length' && (typeof key !== 'string'
      || !/^\d+$/u.test(key) || Number(key) >= value.length
      || !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value')
      || descriptors[key].enumerable !== true))) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API redaction pages must be dense data-only values.');
  }
  let previous = 0;
  const result = Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value).map((page) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100 || page <= previous) {
      apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API redaction pages must ascend within the fixed bound.');
    }
    previous = page;
    return page;
  });
  return Object.freeze(result);
}

function selection(value) {
  const item = exact(value, ['id', 'kind', 'pages'], 'automation operation selection');
  if (!['operation', 'preset', 'sequence'].includes(item.kind)
    || typeof item.id !== 'string' || item.id.length > 128) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API operation selection is invalid.');
  }
  if (item.kind === 'operation' && !OPERATIONS.has(item.id)) {
    apiFail('AUTOMATION_API_OPERATION_DENIED', 'Automation API operation is not allowlisted.', 403);
  }
  if (item.kind === 'preset' && !PRESETS.has(item.id)) {
    apiFail('AUTOMATION_API_OPERATION_DENIED', 'Automation API preset is not allowlisted.', 403);
  }
  if (item.kind === 'sequence' && !SEQUENCES.has(item.id)) {
    apiFail('AUTOMATION_API_OPERATION_DENIED', 'Automation API sequence is not allowlisted.', 403);
  }
  if (item.kind === 'operation' && item.id === AUTOMATION_FULL_PAGE_REDACTION_TYPE) {
    return Object.freeze({ kind: item.kind, id: item.id, pages: pages(item.pages) });
  }
  if (item.pages !== null) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Pages are only accepted by full-page redaction.');
  }
  return Object.freeze({ kind: item.kind, id: item.id, pages: null });
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
  if (!OPAQUE_ID.test(item.jobId ?? '')) apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API job ID is invalid.');
  return Object.freeze({ schemaVersion: AUTOMATION_API_SCHEMA_VERSION, principal: caller, grant: capabilityGrant, jobId: item.jobId });
}

export function normalizeAutomationApiStatusRequest(value) { return normalizeJobRequest(value, 'status'); }
export function normalizeAutomationApiCancelRequest(value) { return normalizeJobRequest(value, 'cancel'); }

export function normalizeAutomationApiPollRequest(value) {
  const item = exact(value, ['grant', 'jobId', 'maxWaitMs', 'principal'], 'automation API poll request');
  const base = normalizeJobRequest({ grant: item.grant, jobId: item.jobId, principal: item.principal }, 'poll');
  if (!Number.isSafeInteger(item.maxWaitMs) || item.maxWaitMs < 0 || item.maxWaitMs > AUTOMATION_API_MAX_POLL_MS) {
    apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API poll timeout is outside the fixed bound.');
  }
  return Object.freeze({ ...base, maxWaitMs: item.maxWaitMs });
}

export function normalizeAutomationApiOutputRequest(value) {
  const item = exact(value, ['grant', 'jobId', 'outputId', 'outputSha256', 'principal'], 'automation API output request');
  const caller = principal(item.principal);
  const capabilityGrant = grant(item.grant);
  if (capabilityGrant.principal !== caller) apiFail('AUTOMATION_API_GRANT_MISMATCH', 'Capability grant principal does not match the caller.', 403);
  if (!OPAQUE_ID.test(item.jobId ?? '')) apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API job ID is invalid.');
  if (!OPAQUE_ID.test(item.outputId ?? '') || !SHA256.test(item.outputSha256 ?? '')) apiFail('INVALID_AUTOMATION_API_REQUEST', 'Automation API output binding is invalid.');
  return Object.freeze({ schemaVersion: AUTOMATION_API_SCHEMA_VERSION, principal: caller, grant: capabilityGrant, jobId: item.jobId, outputId: item.outputId, outputSha256: item.outputSha256 });
}

export function requiredCapability(action) {
  const value = `automation.${action}`;
  if (!CAPABILITY.has(value)) throw new Error('Unsupported automation API action.');
  return value;
}

export function publicAutomationApiReceipt(value) {
  const seen = new Set();
  function copy(item, depth = 0) {
    if (depth > 8) apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt is too deep.', 502);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (Array.isArray(item)) {
      if (nodeTypes.isProxy(item) || item.length > 500) apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt array is invalid.', 502);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(item);
      if (keys.length !== item.length + 1
        || keys.some((key) => key !== 'length' && (typeof key !== 'string'
          || !/^\d+$/u.test(key) || Number(key) >= item.length
          || !Object.hasOwn(descriptors, key)
          || !Object.hasOwn(descriptors[key], 'value')
          || descriptors[key].enumerable !== true))) {
        apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt array must be dense data-only values.', 502);
      }
      return Object.freeze(Array.from({ length: item.length }, (_, index) => descriptors[String(index)].value).map((entry) => copy(entry, depth + 1)));
    }
    if (!item || typeof item !== 'object' || nodeTypes.isProxy(item) || Object.getPrototypeOf(item) !== Object.prototype || seen.has(item)) apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt is invalid.', 502);
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const out = {};
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string' || FORBIDDEN_KEYS.test(key)) continue;
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) apiFail('AUTOMATION_API_RESULT_INVALID', 'Automation API receipt contains an accessor.', 502);
      out[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(item);
    return Object.freeze(out);
  }
  return copy(value);
}

export const automationApiCapabilityGrant = (grantId, principalId) => Object.freeze({ grantId, principal: principalId });
