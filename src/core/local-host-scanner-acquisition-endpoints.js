const DEVICE_ID = /^scanner-[0-9a-f]{32}$/u;
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const COLORS = new Set(['bw', 'gray', 'color']);
const DPIS = new Set([150, 300, 600]);
const PROFILE = 'local-scan-acquire-v1';
const DOCUMENT_KEYS = ['id', 'displayName', 'mediaType', 'size', 'sha256', 'origin', 'operation', 'createdAt'];
const EVIDENCE_KEYS = ['sourceFree', 'pageCount', 'helperVerified', 'outputDigestBound', 'localOnly'];
const VALIDATORS = ['pinned-helper-sha256', 'private-workspace', 'scanner-output-identity', 'scanner-output-digest', 'pdf-header', 'single-page-acquisition'];

function invalid(message = 'Scanner acquisition response is invalid.') { throw new TypeError(message); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  try {
    const ownKeys = Reflect.ownKeys(value); const descriptors = Object.getOwnPropertyDescriptors(value);
    return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], 'value'));
  } catch { return false; }
}
function exactArray(value, expected) {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length || value.length !== expected.length) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.keys(descriptors).length === expected.length + 1
      && descriptors.length?.value === expected.length && descriptors.length.enumerable === false
      && expected.every((item, index) => descriptors[index]?.enumerable === true
        && Object.hasOwn(descriptors[index], 'value') && descriptors[index].value === item);
  } catch { return false; }
}
function timestamp(value) {
  try { return typeof value === 'string' && new Date(value).toISOString() === value; } catch { return false; }
}
function operation(value, request, document) {
  if (!exact(value, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    || value.schemaVersion !== 1 || !DOCUMENT_ID.test(value.id ?? '') || value.type !== 'scan-acquire'
    || !exactArray(value.inputs, []) || !timestamp(value.completedAt)) return false;
  const parameters = value.parameters; const expected = value.expected; const validation = value.validation;
  return exact(parameters, ['profile', 'deviceId', 'source', 'duplex', 'color', 'dpi', 'pageCount', 'format'])
    && parameters.profile === PROFILE && parameters.deviceId === request.deviceId && parameters.source === 'flatbed'
    && parameters.duplex === false && parameters.color === request.color && parameters.dpi === request.dpi
    && parameters.pageCount === 1 && parameters.format === 'PDF'
    && exact(expected, ['pageCount', 'outputSha256', 'sourceFree']) && expected.pageCount === 1
    && expected.outputSha256 === document.sha256 && expected.sourceFree === true
    && exact(validation, ['passed', 'validators', 'outputSha256']) && validation.passed === true
    && exactArray(validation.validators, VALIDATORS) && validation.outputSha256 === document.sha256;
}
function document(value, request) {
  return exact(value, DOCUMENT_KEYS) && DOCUMENT_ID.test(value.id ?? '') && value.displayName === 'scan.pdf'
    && value.mediaType === 'application/pdf' && Number.isSafeInteger(value.size) && value.size > 0
    && value.size <= 64 * 1024 * 1024 && SHA256.test(value.sha256 ?? '') && value.origin === 'derived'
    && timestamp(value.createdAt) && operation(value.operation, request, value);
}
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function validate(body, request) {
  if (!exact(body, ['document', 'operation', 'evidence']) || !document(body.document, request)
    || JSON.stringify(body.operation) !== JSON.stringify(body.document.operation)
    || !exact(body.evidence, EVIDENCE_KEYS) || body.evidence.sourceFree !== true
    || body.evidence.pageCount !== 1 || body.evidence.helperVerified !== true
    || body.evidence.outputDigestBound !== true || body.evidence.localOnly !== true) invalid();
  return freeze(body);
}
function validOptions(value) {
  const keys = value?.signal === undefined ? ['deviceId', 'color', 'dpi'] : ['deviceId', 'color', 'dpi', 'signal'];
  return exact(value, keys) && DEVICE_ID.test(value.deviceId ?? '') && COLORS.has(value.color)
    && DPIS.has(value.dpi) && (value.signal === undefined || value.signal instanceof AbortSignal);
}

export function createScannerAcquisitionEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Scanner acquisition endpoints require JSON transport.');
  return Object.freeze({
    acquireScanner(options) {
      if (!validOptions(options)) throw new TypeError('Scanner acquisition options are invalid.');
      const request = { deviceId: options.deviceId, color: options.color, dpi: options.dpi };
      return json('/api/scanners/acquire', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: options.signal,
      }).then((body) => validate(body, request));
    },
  });
}

export { validate as validateScannerAcquisitionResult };
