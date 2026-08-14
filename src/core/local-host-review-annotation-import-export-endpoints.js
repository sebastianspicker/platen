import { PlatenError } from './errors.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE = 'local-review-annotation-import-export-v1';
const SHA256 = /^[a-f0-9]{64}$/u;

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function normalizedRequest(value) {
  const canonicalEnvelope = typeof value?.xfdf === 'string'
    && value.xfdf.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots><text ')
    && value.xfdf.endsWith('</text></annots></xfdf>\n');
  if (!exact(value, ['profile', 'sourceSha256', 'expectedRevision', 'xfdf'])
    || value.profile !== PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE
    || !SHA256.test(value.sourceSha256 ?? '')
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision > 1_000_000
    || !canonicalEnvelope || Buffer.byteLength(value.xfdf, 'utf8') < 1 || Buffer.byteLength(value.xfdf, 'utf8') > 16 * 1024) {
    throw new TypeError('Review annotation import/export options are invalid.');
  }
  return freeze({ ...value });
}
function invalid() {
  throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid review annotation import/export result.');
}
export function validateReviewAnnotationImportExportResult(result, { documentId, request } = {}) {
  const value = normalizedRequest(request);
  const artifact = result?.artifact; const annotation = result?.annotation;
  const validAnnotation = exact(annotation, ['subtype', 'page', 'rect', 'contentsSha256', ...(Object.hasOwn(annotation ?? {}, 'nameSha256') ? ['nameSha256'] : []), 'outputSha256'])
    && annotation.subtype === 'Text' && Number.isSafeInteger(annotation.page) && annotation.page >= 1
    && Array.isArray(annotation.rect) && annotation.rect.length === 4
    && annotation.rect.every((item) => typeof item === 'number' && Number.isFinite(item))
    && SHA256.test(annotation.contentsSha256 ?? '')
    && (annotation.nameSha256 === undefined || SHA256.test(annotation.nameSha256));
  const validArtifact = exact(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== documentId
    && artifact.documentId === documentId && artifact.mediaType === 'application/pdf'
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== value.sourceSha256;
  const evidenceKeys = ['sourceDigestReverified', 'sourceRevisionReverified', 'sourcePrefixPreserved', 'canonicalXfdfTextOnly', 'inertTextAnnotationReinspected', 'artifactDigestBound', 'sourceUnchanged', 'localOnly'];
  if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exact(result, ['kind', 'sourceDigest', 'revision', 'artifact', 'annotation', 'xfdf', 'evidence', 'limitations'])
    || result.kind !== 'pdf-review-annotation-import-export' || result.sourceDigest !== value.sourceSha256
    || result.revision !== value.expectedRevision || result.xfdf !== value.xfdf || !validArtifact || !validAnnotation
    || annotation.outputSha256 !== artifact.sha256 || !exact(result.evidence, evidenceKeys)
    || Object.values(result.evidence).some((item) => item !== true)
    || !Array.isArray(result.limitations) || result.limitations.length < 1
    || result.limitations.some((item) => typeof item !== 'string' || !item)) invalid();
  return freeze({
    kind: result.kind, sourceDigest: result.sourceDigest, revision: result.revision,
    artifact: { ...artifact, operation: { ...artifact.operation } },
    annotation: { ...annotation, rect: [...annotation.rect] }, xfdf: result.xfdf,
    evidence: { ...result.evidence }, limitations: [...result.limitations],
  });
}
export function createReviewAnnotationImportExportEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Review annotation import/export endpoints require a JSON transport.');
  function importReviewAnnotationXfdf(documentId, request, options = {}) {
    const optionKeys = options?.signal === undefined ? [] : ['signal'];
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exact(options, optionKeys)
      || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      throw new TypeError('Review annotation import/export options are invalid.');
    }
    const value = normalizedRequest(request);
    return json(`/api/documents/${encodeURIComponent(documentId)}/review-annotation-import-export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: options.signal,
    }).then((body) => validateReviewAnnotationImportExportResult(body?.result, { documentId, request: value }));
  }
  return Object.freeze({ importReviewAnnotationXfdf, importExportReviewAnnotation: importReviewAnnotationXfdf });
}
