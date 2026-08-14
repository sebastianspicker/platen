import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
import { PDF_XFA_INSPECTION_LIMITS, PDF_XFA_INSPECTION_PROFILE } from '../../scripts/host/pdf-xfa-inspection-contract.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const PROOF_KEYS = Object.freeze(['schema', 'profile', 'sourceSha256', 'sourceBytes', 'revisionCount', 'effectiveObjectCount', 'xfaPresent', 'inspection']);
const LIMITATIONS = Object.freeze([
  'This inspection reports only whether the Catalog or a direct Catalog AcroForm dictionary contains an XFA key in one bounded unencrypted classic PDF revision.',
  'Any detected XFA is unsupported. The operation does not dereference, read, render, fill, convert, validate, return, preserve, or otherwise process XFA data.',
]);

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

function dense(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_, index) => Object.hasOwn(descriptors[index], 'value') && descriptors[index].enumerable === true).every(Boolean);
}

function integer(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }

function validProof(proof, sourceSha256) {
  return exact(proof, PROOF_KEYS) && proof.schema === 'pdf-xfa-presence-inspection-v1'
    && proof.profile === PDF_XFA_INSPECTION_PROFILE && proof.sourceSha256 === sourceSha256
    && integer(proof.sourceBytes, 32, PDF_XFA_INSPECTION_LIMITS.maxSourceBytes)
    && proof.revisionCount === 1 && integer(proof.effectiveObjectCount, 1, PDF_XFA_INSPECTION_LIMITS.maxObjects)
    && typeof proof.xfaPresent === 'boolean' && proof.inspection === 'catalog-and-direct-acroform-key-presence-only';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateResult(result, sourceSha256) {
  if (!exact(result, ['kind', 'xfaPresent', 'proof', 'limitations']) || result.kind !== 'pdf-xfa-presence-inspection'
    || typeof result.xfaPresent !== 'boolean' || !validProof(result.proof, sourceSha256) || result.xfaPresent !== result.proof.xfaPresent
    || !dense(result.limitations, LIMITATIONS.length) || JSON.stringify(result.limitations) !== JSON.stringify(LIMITATIONS)) {
    const error = new Error('The XFA inspection result is invalid.');
    error.code = 'INVALID_LOCAL_HOST';
    throw error;
  }
  return deepFreeze(result);
}

function endpoint(json, documentId, sourceSha256, options) {
  const optionKeys = options?.signal === undefined ? [] : ['signal'];
  if (typeof json !== 'function' || !OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
    || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('XFA inspection options are invalid.');
  const request = Object.freeze({ profile: PDF_XFA_INSPECTION_PROFILE, sourceSha256 });
  return json(`/api/documents/${encodeURIComponent(documentId)}/xfa-inspection`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: options.signal,
  }).then((body) => validateResult(body?.result, sourceSha256));
}

export function createPdfXfaInspectionEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('XFA inspection endpoints require JSON transport.');
  const inspect = (documentId, sourceSha256, options = {}) => endpoint(json, documentId, sourceSha256, options);
  return Object.freeze({ inspectPdfXfaPresence: inspect, inspectXfaPresence: inspect });
}

export { validateResult as validatePdfXfaInspectionResult };
