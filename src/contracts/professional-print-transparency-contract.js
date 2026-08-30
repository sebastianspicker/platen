import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY = 'print.transparency-flattening';
export const PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE = 'fixed-ghostscript-flatten-transparency';
export const PROFESSIONAL_PRINT_TRANSPARENCY_LIMITATION = 'The fixed local Ghostscript PDF 1.3 rewrite preserves source provenance and page count but does not prove that every transparency construct was flattened or certify standards or press suitability.';

const SHA256 = /^[0-9a-f]{64}$/u;
const REQUEST_KEYS = Object.freeze(['profile', 'sourceSha256']);
const RESULT_KEYS = Object.freeze([
  'kind', 'schemaVersion', 'capabilityId', 'ok', 'localOnly', 'method', 'profile', 'sourceSha256',
  'outputDocumentId', 'outputSha256', 'size', 'pageCount', 'operationType', 'compatibilityLevel',
  'flatteningVerified', 'authoritative', 'certified', 'limitations',
]);
const RESPONSE_KEYS = Object.freeze(['result']);
const MAX_SIZE = 512 * 1024 * 1024;

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_LOCAL_HOST';
  throw error;
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let prototype;
  let descriptors;
  let own;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    own = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype && own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

function inspect(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 512 || depth > 8) invalid('Transparency data is too large or deeply nested.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    state.stringUnits += value.length;
    if (state.stringUnits > 100_000 || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) invalid('Transparency data contains invalid text.');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('Transparency data contains a non-finite number.');
    return;
  }
  if (typeof value !== 'object' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    invalid('Transparency data must contain JSON-compatible values only.');
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) invalid('Transparency data contains an unsupported binary value.');
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    invalid('Transparency data contains a hostile object.');
  }
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || !Object.hasOwn(descriptors, 'length')
      || !Object.hasOwn(descriptors.length, 'value') || descriptors.length.enumerable
      || descriptors.length.configurable || !Number.isSafeInteger(descriptors.length.value)
      || descriptors.length.value < 0 || keys.length !== descriptors.length.value + 1) {
      invalid('Transparency arrays must be ordinary dense arrays.');
    }
    for (let index = 0; index < descriptors.length.value; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalid('Transparency arrays must be ordinary dense arrays.');
    }
    if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)))) invalid('Transparency arrays must not contain symbols or extras.');
  } else if (prototype !== Object.prototype || keys.some((key) => typeof key !== 'string')) {
    invalid('Transparency data must use ordinary objects.');
  }
  if (state.active.has(value)) invalid('Transparency data must not contain cycles.');
  state.active.add(value);
  for (const key of keys) {
    if (key === 'length') continue;
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalid('Transparency data must contain data properties only.');
    inspect(descriptor.value, state, depth + 1);
  }
  state.active.delete(value);
}

function snapshot(value) {
  inspect(value, { active: new Set(), nodes: 0, stringUnits: 0 });
  try {
    return structuredClone(value);
  } catch {
    invalid('Transparency data cannot be detached safely.');
  }
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

function frozenSnapshot(value) {
  return freezeDeep(snapshot(value));
}

function validRequest(value) {
  return exact(value, REQUEST_KEYS) && value.profile === PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE
    && typeof value.sourceSha256 === 'string' && SHA256.test(value.sourceSha256);
}

export function normalizeProfessionalPrintTransparencyRequest(value) {
  const request = snapshot(value);
  if (!validRequest(request)) invalid('Professional print transparency request is invalid.');
  return frozenSnapshot({ profile: request.profile, sourceSha256: request.sourceSha256 });
}

function validLimitations(value) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length === 1
    && Reflect.ownKeys(value).length === 2 && Object.hasOwn(value, 0) && value[0] === PROFESSIONAL_PRINT_TRANSPARENCY_LIMITATION;
}

function validResult(value, request, sourceDocumentId = null) {
  if (!exact(value, RESULT_KEYS) || value.kind !== 'professional-capability-result' || value.schemaVersion !== 1
    || value.capabilityId !== PROFESSIONAL_PRINT_TRANSPARENCY_CAPABILITY || value.ok !== true || value.localOnly !== true
    || value.method !== 'validated-ghostscript-transparency-flatten-service' || value.profile !== PROFESSIONAL_PRINT_TRANSPARENCY_PROFILE
    || typeof value.sourceSha256 !== 'string' || value.sourceSha256 !== request.sourceSha256
    || typeof value.outputDocumentId !== 'string' || !OPAQUE_ID_PATTERN.test(value.outputDocumentId)
    || (sourceDocumentId !== null && value.outputDocumentId === sourceDocumentId)
    || typeof value.outputSha256 !== 'string' || !SHA256.test(value.outputSha256)
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_SIZE
    || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 1_000_000
    || value.operationType !== 'flatten-transparency' || value.compatibilityLevel !== '1.3'
    || value.flatteningVerified !== false || value.authoritative !== false || value.certified !== false
    || !validLimitations(value.limitations) || value.limitations[0] !== PROFESSIONAL_PRINT_TRANSPARENCY_LIMITATION) {
    invalid('Professional print transparency result is invalid.');
  }
  return value;
}

export function validateProfessionalPrintTransparencyResult(value, request, sourceDocumentId = null) {
  const normalizedRequest = normalizeProfessionalPrintTransparencyRequest(request);
  const result = snapshot(value);
  return freezeDeep(validResult(result, normalizedRequest, sourceDocumentId));
}

export function validateProfessionalPrintTransparencyResponse(value, request, sourceDocumentId = null) {
  const response = snapshot(value);
  if (!exact(response, RESPONSE_KEYS)) invalid('Professional print transparency response is invalid.');
  return validateProfessionalPrintTransparencyResult(response.result, request, sourceDocumentId);
}
