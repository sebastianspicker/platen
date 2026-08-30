import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_COPY_PAGE_PROFILE = 'local-copy-one-page-between-documents-v1';
export const PDF_COPY_PAGE_VALIDATORS = Object.freeze([
  'source-sha256',
  'private-source-copy',
  'bounded-passive-graph-scan',
  'poppler-page-boxes-text-render-manifest',
]);
export const PDF_COPY_PAGE_LIMITATIONS = Object.freeze([
  'Copies exactly one selected page from a distinct secondary PDF into a derived copy of the primary PDF.',
  'Only bounded, unsigned, unencrypted, passive inputs with no unsupported document-level structures are accepted.',
  'Validation binds page boxes, rotation, normalized extracted text, and fixed-resolution renders in exact output order; it does not promise byte, object, document-structure, or signature preservation.',
]);

const SHA256 = /^[0-9a-f]{64}$/;

function sameList(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function validArtifactEnvelope(artifact, context) {
  return exactObject(artifact, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation',
    'createdAt',
  ]) && OPAQUE_ID_PATTERN.test(artifact.id ?? '')
    && artifact.id !== context.primaryDocumentId
    && artifact.id !== context.secondaryDocumentId
    && artifact.documentId === context.primaryDocumentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64
    && artifact.size <= 512 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '')
    && artifact.sha256 !== context.request.primarySourceSha256
    && artifact.sha256 !== context.request.secondarySourceSha256
    && typeof artifact.createdAt === 'string'
    && !Number.isNaN(Date.parse(artifact.createdAt));
}

function expectedSelections(pageCount, request) {
  const primaryPageCount = pageCount - 1;
  if (primaryPageCount < 1 || primaryPageCount > 100
    || request.afterPage > primaryPageCount) return null;
  const selections = [];
  for (let page = 1; page <= request.afterPage; page += 1) {
    selections.push({ input: 0, page });
  }
  selections.push({ input: 1, page: request.sourcePage });
  for (let page = request.afterPage + 1; page <= primaryPageCount; page += 1) {
    selections.push({ input: 0, page });
  }
  return selections;
}

function validOperation(operation, artifact, context) {
  if (!exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation',
    'completedAt',
  ]) || operation.schemaVersion !== 1 || !OPAQUE_ID_PATTERN.test(operation.id ?? '')
    || operation.type !== 'copy-page-between-documents'
    || typeof operation.completedAt !== 'string'
    || Number.isNaN(Date.parse(operation.completedAt))
    || !Array.isArray(operation.inputs) || operation.inputs.length !== 2) return false;
  const expectedInputs = [
    {
      documentId: context.primaryDocumentId,
      sha256: context.request.primarySourceSha256,
      role: 'primary',
    },
    {
      documentId: context.secondaryDocumentId,
      sha256: context.request.secondarySourceSha256,
      role: 'secondary',
    },
  ];
  if (operation.inputs.some((input, index) => !exactObject(input, [
    'documentId', 'sha256', 'role',
  ]) || Object.keys(expectedInputs[index]).some(
    (key) => input[key] !== expectedInputs[index][key],
  ))) return false;
  if (!exactObject(operation.parameters, [
    'profile', 'sourcePage', 'afterPage', 'selections',
  ]) || operation.parameters.profile !== PDF_COPY_PAGE_PROFILE
    || operation.parameters.sourcePage !== context.request.sourcePage
    || operation.parameters.afterPage !== context.request.afterPage) return false;
  if (!exactObject(operation.expected, ['pageCount', 'manifestSha256'])
    || !Number.isSafeInteger(operation.expected.pageCount)
    || operation.expected.pageCount < 2 || operation.expected.pageCount > 101
    || !SHA256.test(operation.expected.manifestSha256 ?? '')) return false;
  const selections = expectedSelections(operation.expected.pageCount, context.request);
  if (!selections || JSON.stringify(operation.parameters.selections) !== JSON.stringify(selections)) {
    return false;
  }
  return exactObject(operation.validation, [
    'passed', 'validators', 'pageCount', 'manifestSha256',
  ]) && operation.validation.passed === true
    && sameList(operation.validation.validators, PDF_COPY_PAGE_VALIDATORS)
    && operation.validation.pageCount === operation.expected.pageCount
    && operation.validation.manifestSha256 === operation.expected.manifestSha256
    && artifact.operation === operation;
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound cross-document page-copy artifact.',
  );
}

export function validatePdfCopyPageArtifact(artifact, context) {
  if (!validArtifactEnvelope(artifact, context)
    || !validOperation(artifact.operation, artifact, context)) invalidResult();
  return artifact;
}
