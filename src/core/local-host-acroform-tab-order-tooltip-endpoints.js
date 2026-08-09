import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const PROFILE = 'local-pdf-acroform-tab-order-tooltip-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VALIDATORS = ['source-sha256', 'private-source-copy', 'bounded-tab-order-tooltip-core', 'independent-tab-order-tooltip-reinspection', 'output-sha256'];

function exact(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}
function validText(value) {
  return typeof value === 'string' && value === value.normalize('NFC')
    && [...value].length >= 1 && [...value].length <= 127
    && new TextEncoder().encode(value).length <= 512
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value);
}
function validRequest(documentId, request, options) {
  return OPAQUE_ID_PATTERN.test(documentId ?? '') && exact(options, options.signal === undefined ? [] : ['signal'])
    && (options.signal === undefined || options.signal instanceof AbortSignal)
    && exact(request, ['profile', 'sourceSha256', 'target', 'tooltip'])
    && request.profile === PROFILE && SHA256.test(request.sourceSha256 ?? '') && validText(request.tooltip)
    && exact(request.target, ['page', 'annotationIndex', 'fingerprint'])
    && Number.isSafeInteger(request.target.page) && request.target.page >= 1 && request.target.page <= 10_000
    && Number.isSafeInteger(request.target.annotationIndex) && request.target.annotationIndex >= 0 && request.target.annotationIndex < 50
    && SHA256.test(request.target.fingerprint ?? '');
}
function validArtifact(artifact, documentId, sourceSha256) {
  const operation = artifact?.operation;
  return exact(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.documentId === documentId
    && artifact.displayName === 'tab-order-tooltip-form.pdf' && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size > 0 && SHA256.test(artifact.sha256 ?? '')
    && exact(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && operation.schemaVersion === 1 && UUID.test(operation.id ?? '') && operation.type === 'pdf-acroform-tab-order-tooltip'
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === documentId && operation.inputs[0].sha256 === sourceSha256 && operation.inputs[0].role === 'source'
    && operation.validation?.passed === true && operation.validation.outputSha256 === artifact.sha256
    && JSON.stringify(operation.validation.validators) === JSON.stringify(VALIDATORS);
}
function validateResult(body, context) {
  const result = body?.result; const proof = result?.proof; const target = context.request.target;
  if (!exact(result, ['artifact', 'proof', 'limitations']) || !validArtifact(result.artifact, context.documentId, context.request.sourceSha256)
    || proof?.profile !== PROFILE || proof.sourceSha256 !== context.request.sourceSha256
    || proof.page !== target.page || proof.annotationIndex !== target.annotationIndex || proof.fingerprint !== target.fingerprint
    || !SHA256.test(proof.tooltipSha256 ?? '') || proof.tabOrder !== 'S' || proof.sourcePrefixPreserved !== true
    || !Array.isArray(result.limitations) || result.limitations.length < 1 || result.limitations.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 1_024)) {
    throw new TypeError('AcroForm tab-order tooltip result is invalid.');
  }
  return Object.freeze(result);
}

export function createAcroFormTabOrderTooltipEndpoints({ json }) {
  return Object.freeze({
    updateAcroFormTabOrderTooltip(documentId, request, options = {}) {
      if (!validRequest(documentId, request, options)) throw new TypeError('AcroForm tab-order tooltip request is invalid.');
      const fixed = Object.freeze({ ...request, target: Object.freeze({ ...request.target }) });
      return json(`/api/documents/${encodeURIComponent(documentId)}/acroform-tab-order-tooltip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixed), signal: options.signal })
        .then((body) => validateResult(body, { documentId, request: fixed }));
    },
  });
}
