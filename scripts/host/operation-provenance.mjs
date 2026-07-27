import { randomUUID } from 'node:crypto';
import { HostError } from './host-error.mjs';

export const OPERATION_PROVENANCE_VERSION = 1;

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCUMENT_ID = OPERATION_ID;
const DIGEST = /^[0-9a-f]{64}$/i;
const TOKEN = /^[a-z][a-z0-9-]{1,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 10_000;
const MAX_STRING_LENGTH = 16_384;
const MAX_ARRAY_LENGTH = 1_000;
const MAX_OBJECT_KEYS = 256;

function invalid(message) {
  throw new HostError('INVALID_OPERATION_PROVENANCE', message, 500);
}

function copyJson(value, path, depth, budget) {
  budget.count += 1;
  if (budget.count > MAX_JSON_NODES) invalid(`${path} is too large.`);
  if (depth > MAX_JSON_DEPTH) invalid(`${path} is too deeply nested.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number.`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) invalid(`${path} contains an oversized string.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) invalid(`${path} contains too many items.`);
    return Object.freeze(value.map((item, index) => copyJson(item, `${path}[${index}]`, depth + 1, budget)));
  }
  if (typeof value !== 'object') invalid(`${path} must be JSON-safe.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must be a plain object.`);
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) invalid(`${path} contains too many properties.`);
  const output = Object.create(null);
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || FORBIDDEN_KEYS.has(key)) invalid(`${path} contains an unsafe property name.`);
    output[key] = copyJson(item, `${path}.${key}`, depth + 1, budget);
  }
  return Object.freeze(output);
}

function jsonObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object.`);
  return copyJson(value, path, 0, { count: 0 });
}

function isoTimestamp(value) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    invalid('completedAt must be a canonical ISO timestamp.');
  }
  return value;
}

function normalizeInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length > 32) {
    invalid('inputs must contain no more than 32 source records.');
  }
  return Object.freeze(inputs.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`inputs[${index}] must be an object.`);
    const hasDocument = Object.hasOwn(input, 'documentId');
    const hasAsset = Object.hasOwn(input, 'assetId');
    if (hasDocument === hasAsset) invalid(`inputs[${index}] must identify exactly one document or input asset.`);
    const resourceId = hasDocument ? input.documentId : input.assetId;
    if (!DOCUMENT_ID.test(String(resourceId ?? ''))) invalid(`inputs[${index}] resource identifier is invalid.`);
    if (!DIGEST.test(String(input.sha256 ?? ''))) invalid(`inputs[${index}].sha256 is invalid.`);
    if (!TOKEN.test(String(input.role ?? ''))) invalid(`inputs[${index}].role is invalid.`);
    return Object.freeze({
      ...(hasDocument ? { documentId: resourceId } : { assetId: resourceId }),
      sha256: input.sha256.toLowerCase(),
      role: input.role,
    });
  }));
}

export function createOperationProvenance({
  id = randomUUID(),
  type,
  inputs,
  parameters = {},
  expected = {},
  validation,
  completedAt = new Date().toISOString(),
}) {
  if (!OPERATION_ID.test(String(id ?? ''))) invalid('id must be an opaque operation identifier.');
  if (!TOKEN.test(String(type ?? ''))) invalid('type must be a lowercase operation token.');
  const checkedValidation = jsonObject(validation, 'validation');
  if (checkedValidation.passed !== true) invalid('validation.passed must be true before an artifact is promoted.');
  if (!Array.isArray(checkedValidation.validators) || checkedValidation.validators.length === 0) {
    invalid('validation.validators must list at least one completed validator.');
  }
  return Object.freeze({
    schemaVersion: OPERATION_PROVENANCE_VERSION,
    id,
    type,
    inputs: normalizeInputs(inputs),
    parameters: jsonObject(parameters, 'parameters'),
    expected: jsonObject(expected, 'expected'),
    validation: checkedValidation,
    completedAt: isoTimestamp(completedAt),
  });
}

export function validateOperationProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('operation provenance is required.');
  if (value.schemaVersion !== OPERATION_PROVENANCE_VERSION) {
    invalid(`schemaVersion must be ${OPERATION_PROVENANCE_VERSION}.`);
  }
  const allowed = new Set(['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt']);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid('operation provenance contains unknown properties.');
  return createOperationProvenance(value);
}
