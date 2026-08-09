import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
import { PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS, PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE } from '../../scripts/host/pdf-form-javascript-contract.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const REPORT_KEYS = Object.freeze([
  'schema', 'profile', 'sourceSha256', 'sourceBytes', 'revisionCount', 'visitedObjectCount',
  'parsedNodeCount', 'actionCount', 'totalScriptBytes', 'actionLoci', 'reviewOnly',
  'rawScriptTextIncluded', 'activeContentExecuted',
]);
const LOCUS_KEYS = Object.freeze([
  'locus', 'trigger', 'fieldReference', 'fieldNameBytesSha256', 'actionReference', 'scriptSha256', 'scriptBytes',
]);
const LIMITATIONS = Object.freeze([
  'This operation inventories only exact inline JavaScript actions attached to K, F, V, or C triggers on merged terminal text widgets in a narrowly admitted classic PDF subset.',
  'It does not expose script text, author, evaluate, execute, mutate, sanitize, or establish trust in any action.',
  'Dynamic, chained, shared, indirect-stream, encrypted, signed, XFA, incremental, compressed-object, catalog-level, or otherwise unsupported action structures are rejected rather than partially reported.',
]);
const TRIGGERS = new Set(['keystroke', 'format', 'validate', 'calculate']);

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

function reference(value) {
  return exact(value, ['object', 'generation']) && integer(value.object, 1, 1_000_000) && integer(value.generation, 0, 65_535);
}

function validReport(report, sourceSha256) {
  if (!exact(report, REPORT_KEYS) || report.schema !== 'pdf-form-javascript-inventory-v1'
    || report.profile !== PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE || report.sourceSha256 !== sourceSha256
    || !integer(report.sourceBytes, 32, PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxSourceBytes)
    || report.revisionCount !== 1 || !integer(report.visitedObjectCount, 1, PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxObjects)
    || !integer(report.parsedNodeCount, 1, PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxNodes)
    || !integer(report.actionCount, 0, PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxActions)
    || !integer(report.totalScriptBytes, 0, PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxTotalScriptBytes)
    || !dense(report.actionLoci, PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxActions)
    || report.actionLoci.length !== report.actionCount || report.reviewOnly !== true
    || report.rawScriptTextIncluded !== false || report.activeContentExecuted !== false) return false;
  const actions = new Set();
  for (const locus of report.actionLoci) {
    if (!exact(locus, LOCUS_KEYS) || locus.locus !== 'field-additional-action' || !TRIGGERS.has(locus.trigger)
      || !reference(locus.fieldReference) || !SHA256.test(locus.fieldNameBytesSha256 ?? '')
      || !reference(locus.actionReference) || !SHA256.test(locus.scriptSha256 ?? '')
      || !integer(locus.scriptBytes, 1, PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxScriptBytes)) return false;
    const action = `${locus.actionReference.object}:${locus.actionReference.generation}`;
    if (actions.has(action)) return false;
    actions.add(action);
  }
  return report.actionLoci.reduce((sum, locus) => sum + locus.scriptBytes, 0) === report.totalScriptBytes;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateResult(result, sourceSha256) {
  if (!exact(result, ['kind', 'report', 'limitations']) || result.kind !== 'pdf-form-javascript-inventory'
    || !validReport(result.report, sourceSha256) || !dense(result.limitations, LIMITATIONS.length)
    || JSON.stringify(result.limitations) !== JSON.stringify(LIMITATIONS)) {
    const error = new Error('The form JavaScript inventory result is invalid.');
    error.code = 'INVALID_LOCAL_HOST';
    throw error;
  }
  return deepFreeze(result);
}

function endpoint(json, documentId, sourceSha256, options) {
  const optionKeys = options?.signal === undefined ? [] : ['signal'];
  if (typeof json !== 'function' || !OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
    || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new TypeError('Form JavaScript inventory options are invalid.');
  }
  const request = Object.freeze({ profile: PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE, sourceSha256 });
  return json(`/api/documents/${encodeURIComponent(documentId)}/form-javascript-inventory`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: options.signal,
  }).then((body) => validateResult(body?.result, sourceSha256));
}

export function createFormJavaScriptInventoryEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Form JavaScript inventory endpoints require JSON transport.');
  const inspect = (documentId, sourceSha256, options = {}) => endpoint(json, documentId, sourceSha256, options);
  return Object.freeze({ inspectFormJavaScriptInventory: inspect, inspectPdfFormJavaScriptInventory: inspect });
}

export const createPdfFormJavaScriptInventoryEndpoints = createFormJavaScriptInventoryEndpoints;

export { validateResult as validateFormJavaScriptInventoryResult };
