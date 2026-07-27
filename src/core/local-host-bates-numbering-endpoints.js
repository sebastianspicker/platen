import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
const PROFILE = 'local-pdf-bates-numbering-v1'; const SHA256 = /^[0-9a-f]{64}$/u; const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu; const POSITIONS = new Set(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']);
const VALIDATORS = Object.freeze(['source-sha256', 'private-stage', 'workspace-inventory', 'bates-writer', 'independent-reinspection']);
function exact(value, keys) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)) && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true); }
function array(value) { if (!Array.isArray(value) || value.length < 1 || value.length > 500 || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) return false; const descriptors = Object.getOwnPropertyDescriptors(value); return descriptors.length.enumerable === false && Object.keys(descriptors).filter((key) => key !== 'length').every((key) => Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true); }
function printable(value) { return typeof value === 'string' && value === value.normalize('NFC') && value.length <= 64 && /^[\x20-\x7E]*$/u.test(value); }
function limitation(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 512 && /^[\x20-\x7E]*$/u.test(value); }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }
function validate(body, context) {
  const result = body?.result; const operation = result?.artifact?.operation; const expectedText = (index) => `${context.request.prefix}${String(context.request.start + index).padStart(context.request.padding, '0')}${context.request.suffix}`;
  const validOperation = exact(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt']) && operation.schemaVersion === 1 && UUID.test(operation.id ?? '') && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt)) && operation.type === 'pdf-bates-numbering' && Array.isArray(operation.inputs) && operation.inputs.length === 1 && exact(operation.inputs[0], ['documentId', 'sha256', 'role']) && operation.inputs[0].documentId === context.documentId && operation.inputs[0].sha256 === context.sourceSha256 && operation.inputs[0].role === 'source'
    && exact(operation.parameters, ['profile', 'pages', 'position', 'padding']) && operation.parameters.profile === PROFILE && JSON.stringify(operation.parameters.pages) === JSON.stringify(context.request.pages) && operation.parameters.position === context.request.position && operation.parameters.padding === context.request.padding
    && exact(operation.expected, ['outputSha256', 'sourcePrefixPreserved']) && operation.expected.outputSha256 === result?.artifact?.sha256 && operation.expected.sourcePrefixPreserved === true && exact(operation.validation, ['passed', 'validators', 'outputSha256']) && operation.validation.passed === true && JSON.stringify(operation.validation.validators) === JSON.stringify(VALIDATORS) && operation.validation.outputSha256 === result?.artifact?.sha256;
  const validArtifact = exact(result, ['artifact', 'proof', 'limitations']) && exact(result.artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt']) && OPAQUE_ID_PATTERN.test(result.artifact.id ?? '') && result.artifact.id !== context.documentId && typeof result.artifact.createdAt === 'string' && !Number.isNaN(Date.parse(result.artifact.createdAt)) && result.artifact.documentId === context.documentId && result.artifact.displayName === 'bates-numbered.pdf' && result.artifact.mediaType === 'application/pdf' && Number.isSafeInteger(result.artifact.size) && result.artifact.size > 0 && SHA256.test(result.artifact.sha256 ?? '') && result.artifact.sha256 !== context.sourceSha256 && validOperation;
  const proof = result?.proof; const validProof = exact(proof, ['profile', 'sourceSha256', 'outputSha256', 'pageCount', 'pages', 'sourcePrefixPreserved', 'revisionCount', 'resourceName']) && proof.profile === PROFILE && proof.sourceSha256 === context.sourceSha256 && SHA256.test(proof.outputSha256 ?? '') && proof.outputSha256 === result.artifact.sha256 && Number.isSafeInteger(proof.pageCount) && proof.pageCount >= Math.max(...context.request.pages) && array(proof.pages) && proof.pages.length === context.request.pages.length && proof.pages.every((entry, index) => exact(entry, ['page', 'text']) && entry.page === context.request.pages[index] && entry.text === expectedText(index)) && proof.sourcePrefixPreserved === true && Number.isSafeInteger(proof.revisionCount) && proof.revisionCount >= 2 && proof.resourceName === 'BatesHelv';
  if (!validArtifact || !validProof || !array(result.limitations) || result.limitations.some((entry) => !limitation(entry))) throw new TypeError('Bates numbering result is invalid.');
  return freeze(result);
}
export function createBatesNumberingEndpoints({ json }) {
  return Object.freeze({
    runBatesNumbering(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      const valid = OPAQUE_ID_PATTERN.test(documentId ?? '') && exactObject(options, optionKeys)
        && (options.signal === undefined || options.signal instanceof AbortSignal)
        && exact(request, ['profile', 'sourceSha256', 'pages', 'start', 'prefix', 'suffix', 'padding', 'position', 'margin', 'fontSize'])
        && request.profile === PROFILE && SHA256.test(request.sourceSha256 ?? '') && array(request.pages)
        && request.pages.every((page, index) => Number.isSafeInteger(page) && page >= 1 && page <= 500 && (index === 0 || page > request.pages[index - 1]))
        && Number.isSafeInteger(request.start) && request.start >= 0 && request.start <= 999_999_999
        && printable(request.prefix) && printable(request.suffix) && Number.isSafeInteger(request.padding) && request.padding >= 1 && request.padding <= 12
        && POSITIONS.has(request.position) && typeof request.margin === 'number' && Number.isFinite(request.margin) && request.margin >= 0 && request.margin <= 1_000_000
        && typeof request.fontSize === 'number' && Number.isFinite(request.fontSize) && request.fontSize > 0 && request.fontSize <= 200
        && request.start + request.pages.length - 1 <= 999_999_999;
      if (!valid) throw new TypeError('Bates numbering request is invalid.');
      const fixed = Object.freeze({ ...request, pages: Object.freeze([...request.pages]) });
      return json(`/api/documents/${encodeURIComponent(documentId)}/bates-numbering`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixed), signal: options.signal }).then((body) => validate(body, { documentId, sourceSha256: fixed.sourceSha256, request: fixed }));
    },
  });
}
