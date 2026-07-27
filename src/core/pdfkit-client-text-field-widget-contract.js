import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN, validPdfKitRectangle } from './pdfkit-client-contract-shared.js';

export const PDFKIT_TEXT_FIELD_WIDGET_PROFILE = 'macos-pdfkit-acroform-text-field-widget-v1';

const DIGEST = /^[0-9a-f]{64}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;
const VALIDATORS = Object.freeze([
  'source-sha256', 'pinned-helper-sha256', 'source-safety',
  'direct-acroform-topology', 'terminal-text-widget', 'pdfkit-reopen',
  'poppler-page-count', 'poppler-render-all-pages', 'artifact-sha256',
]);
const EVIDENCE_KEYS = Object.freeze([
  'engine', 'helperBinaryDigestVerified', 'sourceDigestReverified',
  'directAcroFormTopologyVerified', 'terminalTextWidgetVerified',
  'sourceSafetyVerified', 'preservationVerified', 'reopenedByPdfKit',
  'popplerPageCountMatched', 'allPagesRendered', 'outputSha256',
  'rasterized', 'sourceUnchanged',
]);
const LIMITATIONS = Object.freeze([
  'This creates exactly one direct terminal text AcroForm widget in a separate derived PDF.',
  'Existing forms, widgets, signatures, encryption, actions, tags, layers, and unsupported PDF graphs are rejected.',
  'Field name and default value are retained only as SHA-256 digests in host results and provenance.',
  'This is not PDF/A, PDF/UA, redaction, sanitization, signature preservation, or byte-preservation validation.',
]);

function canonicalText(value, maximumBytes, allowEmpty = false) {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && new TextEncoder().encode(value).length <= maximumBytes
    && value.normalize('NFC') === value && value.trim() === value
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)
    && !/[\p{Cf}]/u.test(value);
}

export function normalizePdfKitTextFieldWidgetRequest(value) {
  if (!exactObject(value, ['page', 'rect', 'fieldName', 'defaultValue'])
    || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 100
    || !validPdfKitRectangle(value.rect)
    || !canonicalText(value.fieldName, 64) || !FIELD_NAME.test(value.fieldName)
    || !(value.defaultValue === null || canonicalText(value.defaultValue, 256, true))) {
    throw new TypeError('PDFKit text-field widget request is invalid.');
  }
  return Object.freeze({
    page: value.page,
    rect: Object.freeze({ ...value.rect }),
    fieldName: value.fieldName,
    defaultValue: value.defaultValue,
  });
}

function invalid() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid PDFKit text-field widget response.',
  );
}

function validArtifact(artifact, documentId, sourceSha256) {
  return exactObject(artifact, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
  ])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== documentId
    && artifact.documentId === documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 1
    && artifact.size <= 256 * 1024 * 1024
    && DIGEST.test(artifact.sha256 ?? '') && artifact.sha256 !== sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

function validOperation(operation, artifact, context, result) {
  return exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation',
    'completedAt',
  ])
    && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === 'pdfkit-acroform-text-field-widget'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, [
      'profile', 'page', 'fieldNameSha256', 'defaultValueSha256', 'rectSha256',
    ])
    && operation.parameters.profile === PDFKIT_TEXT_FIELD_WIDGET_PROFILE
    && operation.parameters.page === context.request.page
    && operation.parameters.fieldNameSha256 === result.fieldNameSha256
    && operation.parameters.defaultValueSha256 === result.defaultValueSha256
    && operation.parameters.rectSha256 === result.rectSha256
    && exactObject(operation.expected, ['pageCount', 'rasterized', 'editCount'])
    && Number.isSafeInteger(operation.expected.pageCount)
    && operation.expected.pageCount >= 1 && operation.expected.pageCount <= 100
    && operation.expected.rasterized === false && operation.expected.editCount === 1
    && exactObject(operation.validation, [
      'passed', 'validators', 'pageCount', 'renderedPages', 'appliedEdits', 'outputSha256',
    ])
    && operation.validation.passed === true
    && Array.isArray(operation.validation.validators)
    && operation.validation.validators.length === VALIDATORS.length
    && operation.validation.validators.every((entry, index) => entry === VALIDATORS[index])
    && operation.validation.pageCount === operation.expected.pageCount
    && operation.validation.renderedPages === operation.expected.pageCount
    && operation.validation.appliedEdits === 1
    && operation.validation.outputSha256 === artifact.sha256;
}

export function validatePdfKitTextFieldWidgetResult(result, context) {
  if (!exactObject(result, [
    'kind', 'sourceDigest', 'artifact', 'page', 'fieldNameSha256',
    'defaultValueSha256', 'rectSha256', 'evidence', 'limitations',
  ])
    || result.kind !== 'pdfkit-acroform-text-field-widget'
    || result.sourceDigest !== context.sourceSha256
    || result.page !== context.request.page
    || !DIGEST.test(result.fieldNameSha256 ?? '')
    || !DIGEST.test(result.defaultValueSha256 ?? '')
    || !DIGEST.test(result.rectSha256 ?? '')
    || !validArtifact(result.artifact, context.documentId, context.sourceSha256)
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || result.evidence.engine !== 'Apple PDFKit'
    || EVIDENCE_KEYS.filter((key) => !['engine', 'outputSha256', 'rasterized'].includes(key))
      .some((key) => result.evidence[key] !== true)
    || result.evidence.outputSha256 !== result.artifact.sha256
    || result.evidence.rasterized !== false
    || !Array.isArray(result.limitations) || result.limitations.length !== LIMITATIONS.length
    || result.limitations.some((entry, index) => entry !== LIMITATIONS[index])
    || !validOperation(result.artifact.operation, result.artifact, context, result)) invalid();
  return result;
}
