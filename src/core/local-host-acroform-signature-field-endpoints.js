import { exactObject, OPAQUE_ID_PATTERN, validPdfKitRectangle } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const PROFILE = 'local-pdf-acroform-signature-field-v1';
const LIMITATIONS = Object.freeze([
  'One empty passive terminal signature field only; no signing, certificate, key custody, appearance, timestamp, identity, or LTV operation is performed.',
  'Existing forms, widgets, signatures, encryption, tags, layers, actions, JavaScript, calculations, XFA, rotation, and unsupported PDF graphs are rejected.',
]);
const VALIDATORS = Object.freeze(['source-sha256', 'private-source-copy', 'bounded-acroform-signature-field-core', 'independent-signature-field-reinspection', 'output-sha256']);
function canonicalTimestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function canonicalNumber(value) { return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && Math.abs(value) <= 1_000_000 && Math.round(value * 1_000_000) === value * 1_000_000; }
function canonicalRect(value) { return exact(value, ['x', 'y', 'width', 'height']) && Object.values(value).every(canonicalNumber) && value.width > 0 && value.height > 0; }
function text(value) { return typeof value === 'string' && value === value.normalize('NFC') && [...value].length >= 1 && [...value].length <= 127 && new TextEncoder().encode(value).length <= 512 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value);
}
function exact(value, keys) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)) && Reflect.ownKeys(value).length === keys.length && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
}
function sameRect(left, right) { return exact(left, ['x', 'y', 'width', 'height']) && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
for (const child of Object.values(value)) freeze(child);
return Object.freeze(value);
}
function plainArray(value) { if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) return false;
const descriptors = Object.getOwnPropertyDescriptors(value);
return Object.hasOwn(descriptors, 'length') && descriptors.length.enumerable === false && Object.keys(descriptors).filter((key) => key !== 'length').every((key) => Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}
function validArtifact(artifact, documentId, sourceSha256) { return exact(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt']) && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== documentId && artifact.documentId === documentId && artifact.displayName === 'signature-field-form.pdf' && artifact.mediaType === 'application/pdf' && Number.isSafeInteger(artifact.size) && artifact.size >= 64 && artifact.size <= 32 * 1024 * 1024 + 256 * 1024 && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== sourceSha256 && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}
function validOperation(operation, artifact, documentId, sourceSha256, request) {
  return exact(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && OPAQUE_ID_PATTERN.test(operation.id ?? '') && canonicalTimestamp(operation.completedAt)
    && operation.schemaVersion === 1 && operation.type === 'pdf-acroform-signature-field'
    && plainArray(operation.inputs) && operation.inputs.length === 1
    && exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === documentId && operation.inputs[0].sha256 === sourceSha256
    && operation.inputs[0].role === 'source'
    && exact(operation.parameters, ['profile', 'fieldNameSha256', 'page', 'rect'])
    && operation.parameters.profile === PROFILE && SHA256.test(operation.parameters.fieldNameSha256 ?? '')
    && operation.parameters.page === request.page && sameRect(operation.parameters.rect, request.rect)
    && exact(operation.expected, ['outputSha256', 'sourcePrefixPreserved', 'emptyUnsigned', 'signingPerformed'])
    && operation.expected.outputSha256 === artifact.sha256 && operation.expected.sourcePrefixPreserved === true
    && operation.expected.emptyUnsigned === true && operation.expected.signingPerformed === false
    && exact(operation.validation, ['passed', 'validators', 'outputSha256'])
    && operation.validation.passed === true && plainArray(operation.validation.validators)
    && JSON.stringify(operation.validation.validators) === JSON.stringify(VALIDATORS)
    && operation.validation.outputSha256 === artifact.sha256 && typeof operation.completedAt === 'string'
    && !Number.isNaN(Date.parse(operation.completedAt));
}
function validateResult(value, context) {
  const valid = exact(value, ['artifact', 'proof', 'limitations'])
    && validArtifact(value.artifact, context.documentId, context.sourceSha256)
    && validOperation(value.artifact.operation, value.artifact, context.documentId, context.sourceSha256, context.request)
    && exact(value.proof, ['profile', 'sourceSha256', 'page', 'fieldNameSha256', 'rect', 'sourcePrefixPreserved', 'emptyUnsigned', 'objectCount', 'references', 'otherPagesContentResourcesPreserved'])
    && value.proof.profile === PROFILE && value.proof.sourceSha256 === context.sourceSha256
    && value.proof.page === context.request.page && SHA256.test(value.proof.fieldNameSha256 ?? '')
    && value.proof.fieldNameSha256 === value.artifact.operation.parameters.fieldNameSha256
    && canonicalRect(value.proof.rect) && sameRect(value.proof.rect, context.request.rect) && value.proof.sourcePrefixPreserved === true
    && value.proof.emptyUnsigned === true && value.proof.objectCount === 2
    && exact(value.proof.references, ['widget', 'acroForm'])
    && Object.values(value.proof.references).every((reference) => exact(reference, ['object', 'generation']) && Number.isSafeInteger(reference.object) && reference.object > 0 && reference.generation === 0)
    && new Set(Object.values(value.proof.references).map((reference) => `${reference.object}:${reference.generation}`)).size === 2
    && value.proof.otherPagesContentResourcesPreserved === true && plainArray(value.limitations)
    && JSON.stringify(value.limitations) === JSON.stringify(LIMITATIONS)
    && canonicalTimestamp(value.artifact.createdAt);
  if (!valid) throw new TypeError('AcroForm signature-field result is invalid.');
  return freeze(value);
}
export function createAcroFormSignatureFieldEndpoints({ json }) { return Object.freeze({ addAcroFormSignatureField(documentId, request, options = {}) { const optionKeys = options?.signal === undefined ? [] : ['signal'];
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal)) || !exact(request, ['profile', 'sourceSha256', 'page', 'fieldName', 'rect']) || request.profile !== PROFILE || !SHA256.test(request.sourceSha256 ?? '') || !Number.isSafeInteger(request.page) || request.page < 1 || request.page > 10_000 || !text(request.fieldName) || !validPdfKitRectangle(request.rect) || !canonicalRect(request.rect)) throw new TypeError('AcroForm signature-field request is invalid.');
const fixedRequest = Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, fieldName: request.fieldName, rect: Object.freeze({ ...request.rect }) });
return json(`/api/documents/${encodeURIComponent(documentId)}/acroform-signature-field`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixedRequest), signal: options.signal }).then((body) => validateResult(body?.result, { documentId, sourceSha256: fixedRequest.sourceSha256, request: fixedRequest }));
} });
}
