import { exactObject, OPAQUE_ID_PATTERN, validPdfKitRectangle } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const PROFILE = 'local-pdf-acroform-text-field-v1';
const LIMITATIONS = Object.freeze([
  'One empty passive terminal text field only; existing forms, widgets, signatures, encryption, tags, layers, actions, JavaScript, calculations, XFA, and unsupported PDF graphs are rejected.',
  'The source document is preserved; no signature-preservation, PDF/A, or PDF/UA claim is made.',
]);
const VALIDATORS = Object.freeze(['source-sha256', 'private-source-copy', 'bounded-acroform-text-field-core', 'independent-text-field-reinspection', 'output-sha256']);

function text(value) {
  return typeof value === 'string' && value === value.normalize('NFC') && [...value].length >= 1
    && [...value].length <= 127 && new TextEncoder().encode(value).length <= 512
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value);
}
function exact(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)) && Reflect.ownKeys(value).length === keys.length
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
}
function sameRect(left, right) { return exact(left, ['x', 'y', 'width', 'height']) && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height; }
function validReference(reference) {
  const keys = Object.hasOwn(reference ?? {}, 'type') ? ['type', 'object', 'generation'] : ['object', 'generation'];
  return exact(reference, keys) && (reference.type === undefined || reference.type === 'ref')
    && Number.isSafeInteger(reference.object) && reference.object > 0
    && Number.isSafeInteger(reference.generation) && reference.generation >= 0;
}
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }
function plainArray(value) {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Object.hasOwn(descriptors, 'length') || !Object.hasOwn(descriptors.length, 'value') || descriptors.length.enumerable !== false) return false;
  return Object.keys(descriptors).filter((key) => key !== 'length').every((key) => Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}
function validArtifact(artifact, documentId, sourceSha256) {
  return exact(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== documentId && artifact.documentId === documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1 && artifact.displayName.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(artifact.displayName) && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64 && artifact.size <= 32 * 1024 * 1024 + 512 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}
function validOperation(operation, artifact, documentId, sourceSha256, request) {
  if (!exact(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    || operation.schemaVersion !== 1 || !OPAQUE_ID_PATTERN.test(operation.id ?? '') || operation.type !== 'pdf-acroform-text-field'
    || !plainArray(operation.inputs) || operation.inputs.length !== 1 || !exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    || operation.inputs[0].documentId !== documentId || operation.inputs[0].sha256 !== sourceSha256 || operation.inputs[0].role !== 'source'
    || !exact(operation.parameters, ['profile', 'fieldNameSha256', 'page', 'rect']) || operation.parameters.profile !== PROFILE
    || !SHA256.test(operation.parameters.fieldNameSha256 ?? '') || operation.parameters.page !== request.page
    || !sameRect(operation.parameters.rect, request.rect)
    || !exact(operation.expected, ['outputSha256', 'sourcePrefixPreserved', 'defaultEmpty', 'signaturePreservation'])
    || operation.expected.outputSha256 !== artifact.sha256 || operation.expected.sourcePrefixPreserved !== true
    || operation.expected.defaultEmpty !== true || operation.expected.signaturePreservation !== false
    || !exact(operation.validation, ['passed', 'validators', 'outputSha256']) || operation.validation.passed !== true
    || !plainArray(operation.validation.validators) || JSON.stringify(operation.validation.validators) !== JSON.stringify(VALIDATORS)
    || operation.validation.outputSha256 !== artifact.sha256 || typeof operation.completedAt !== 'string' || Number.isNaN(Date.parse(operation.completedAt))) return false;
  return true;
}
function validateResult(value, context) {
  const result = value;
  if (!exact(result, ['artifact', 'proof', 'limitations']) || !validArtifact(result.artifact, context.documentId, context.sourceSha256)
    || !validOperation(result.artifact.operation, result.artifact, context.documentId, context.sourceSha256, context.request)
    || !exact(result.proof, ['profile', 'sourceSha256', 'page', 'fieldNameSha256', 'rect', 'sourcePrefixPreserved', 'defaultEmpty', 'objectCount', 'references', 'otherPagesContentResourcesPreserved'])
    || result.proof.profile !== PROFILE || result.proof.profile !== result.artifact.operation.parameters.profile || result.proof.sourceSha256 !== context.sourceSha256 || result.proof.page !== context.request.page || result.proof.page !== result.artifact.operation.parameters.page
    || !SHA256.test(result.proof.fieldNameSha256 ?? '') || result.proof.fieldNameSha256 !== result.artifact.operation.parameters.fieldNameSha256 || !sameRect(result.proof.rect, context.request.rect) || !sameRect(result.proof.rect, result.artifact.operation.parameters.rect)
    || result.proof.sourcePrefixPreserved !== true || result.proof.defaultEmpty !== true || result.proof.objectCount !== 4
    || !exact(result.proof.references, ['appearance', 'font', 'widget', 'acroForm'])
    || !Object.values(result.proof.references).every(validReference)
    || new Set(Object.values(result.proof.references).map((reference) => `${reference.object}:${reference.generation}`)).size !== 4
    || result.proof.otherPagesContentResourcesPreserved !== true || !plainArray(result.limitations)
    || JSON.stringify(result.limitations) !== JSON.stringify(LIMITATIONS)) throw new TypeError('AcroForm text-field result is invalid.');
  if (result.artifact.displayName !== 'text-field-form.pdf') throw new TypeError('AcroForm text-field result is invalid.');
  return freeze(result);
}

export function createAcroFormTextFieldEndpoints({ json }) {
  return Object.freeze({
    addAcroFormTextField(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
        || !exact(request, ['profile', 'sourceSha256', 'page', 'fieldName', 'rect']) || request.profile !== PROFILE
        || !SHA256.test(request.sourceSha256 ?? '') || !Number.isSafeInteger(request.page) || request.page < 1 || request.page > 10_000
        || !text(request.fieldName) || !validPdfKitRectangle(request.rect)) throw new TypeError('AcroForm text-field request is invalid.');
      const fixedRequest = Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, fieldName: request.fieldName, rect: Object.freeze({ ...request.rect }) });
      return json(`/api/documents/${encodeURIComponent(documentId)}/acroform-text-field`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixedRequest), signal: options.signal })
        .then((body) => validateResult(body?.result, { documentId, sourceSha256: fixedRequest.sourceSha256, request: fixedRequest }));
    },
  });
}
