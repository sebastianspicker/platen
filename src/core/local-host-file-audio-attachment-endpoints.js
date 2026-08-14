import { PlatenError } from './errors.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_FILE_AUDIO_ATTACHMENT_PROFILE = 'local-file-audio-attachment-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_COORDINATE = 1_000_000;
const ARTIFACT_KEYS = Object.freeze([
  'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
]);
const OPERATION_KEYS = Object.freeze([
  'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt',
]);
const VALIDATORS = Object.freeze([
  'source-sha256', 'input-asset-id-digest-media-type-extension', 'private-source-copy',
  'raw-file-audio-attachment-proof', 'embedded-bytes-reinspection', 'annotation-reinspection',
  'workspace-cleanup', 'artifact-sha256',
]);
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'inputAssetReverified', 'sourcePrefixPreserved',
  'embeddedBytesReinspected', 'annotationReinspected', 'passiveFileAttachment', 'noActions',
  'noRichMedia', 'noAutoplay', 'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);
const LIMITATIONS = Object.freeze([
  'One inert FileAttachment annotation is supported; this does not provide Sound actions, RichMedia, recording, microphone access, autoplay, or general annotation authoring.',
  'Only one bounded local .txt, .bin, or validated PCM .wav asset is accepted. Signatures, encryption, tags, forms, actions, layers, existing embedded files, prior revisions, and unsupported graphs fail closed.',
  'The source remains unchanged and historical source bytes remain as the exact prefix of the append-only artifact.',
]);

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

function invalid(message) {
  throw new PlatenError('INVALID_LOCAL_HOST', message);
}

function rect(value) {
  if (!exact(value, ['x', 'y', 'width', 'height'])) throw new TypeError('PDF file/audio attachment rectangle is invalid.');
  const checked = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || Object.is(number, -0)
      || Math.abs(number) > MAX_COORDINATE) throw new TypeError('PDF file/audio attachment rectangle is invalid.');
    checked[key] = Math.round(number * 1_000_000) / 1_000_000;
  }
  if (checked.width <= 0 || checked.height <= 0
    || checked.x + checked.width > MAX_COORDINATE || checked.y + checked.height > MAX_COORDINATE) {
    throw new TypeError('PDF file/audio attachment rectangle is invalid.');
  }
  return Object.freeze(checked);
}

function normalizeRequest(value) {
  if (!exact(value, [
    'profile', 'sourceSha256', 'assetId', 'assetSha256', 'mediaType', 'extension', 'page', 'rect',
  ]) || value.profile !== PDF_FILE_AUDIO_ATTACHMENT_PROFILE
    || !SHA256.test(value.sourceSha256 ?? '') || !OPAQUE_ID_PATTERN.test(value.assetId ?? '')
    || !SHA256.test(value.assetSha256 ?? '')
    || !['text/plain', 'application/octet-stream', 'audio/wav'].includes(value.mediaType)
    || !['.txt', '.bin', '.wav'].includes(value.extension)
    || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 100
    || (value.mediaType === 'audio/wav') !== (value.extension === '.wav')
    || (value.mediaType === 'text/plain' && value.extension !== '.txt')
    || (value.mediaType === 'application/octet-stream' && value.extension !== '.bin')) {
    throw new TypeError('PDF file/audio attachment request is invalid.');
  }
  return Object.freeze({
    profile: PDF_FILE_AUDIO_ATTACHMENT_PROFILE,
    sourceSha256: value.sourceSha256,
    assetId: value.assetId,
    assetSha256: value.assetSha256,
    mediaType: value.mediaType,
    extension: value.extension,
    page: value.page,
    rect: rect(value.rect),
  });
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function sameJson(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function validOperation(operation, { documentId, sourceSha256, request, outputSha256 }) {
  return exact(operation, OPERATION_KEYS) && operation.schemaVersion === 1
    && OPAQUE_ID_PATTERN.test(operation.id ?? '') && operation.type === 'pdf-file-audio-attachment'
    && Array.isArray(operation.inputs) && operation.inputs.length === 2
    && exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === documentId && operation.inputs[0].sha256 === sourceSha256
    && operation.inputs[0].role === 'source'
    && exact(operation.inputs[1], ['assetId', 'sha256', 'role'])
    && operation.inputs[1].assetId === request.assetId && operation.inputs[1].sha256 === request.assetSha256
    && operation.inputs[1].role === 'attachment' && sameJson(operation.parameters, request)
    && exact(operation.expected, ['page', 'sourcePrefixPreserved', 'sourceUnchanged', 'annotationSubtype', 'outputSha256'])
    && operation.expected.page === request.page && operation.expected.sourcePrefixPreserved === true
    && operation.expected.sourceUnchanged === true && operation.expected.annotationSubtype === 'FileAttachment'
    && operation.expected.outputSha256 === outputSha256
    && exact(operation.validation, ['passed', 'validators', 'outputSha256'])
    && operation.validation.passed === true && sameJson(operation.validation.validators, VALIDATORS)
    && operation.validation.outputSha256 === outputSha256 && canonicalTimestamp(operation.completedAt);
}

function validArtifact(artifact, { documentId, sourceSha256, request }) {
  return exact(artifact, ARTIFACT_KEYS) && OPAQUE_ID_PATTERN.test(artifact.id ?? '')
    && artifact.id !== documentId && artifact.documentId === documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.endsWith('-attachment.pdf')
    && !artifact.displayName.includes('/') && !artifact.displayName.includes('\\')
    && artifact.mediaType === 'application/pdf' && Number.isSafeInteger(artifact.size)
    && artifact.size >= 64 && artifact.size <= 145 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== sourceSha256
    && canonicalTimestamp(artifact.createdAt)
    && validOperation(artifact.operation, {
      documentId, sourceSha256, request, outputSha256: artifact.sha256,
    });
}

function validateResult(result, { documentId, sourceSha256, request }) {
  if (!exact(result, ['kind', 'sourceDigest', 'artifact', 'attachment', 'evidence', 'limitations'])
    || result.kind !== 'pdf-file-audio-attachment' || result.sourceDigest !== sourceSha256
    || !exact(result.attachment, ['assetId', 'assetSha256', 'mediaType', 'extension', 'page', 'rect'])
    || result.attachment.assetId !== request.assetId || result.attachment.assetSha256 !== request.assetSha256
    || result.attachment.mediaType !== request.mediaType || result.attachment.extension !== request.extension
    || result.attachment.page !== request.page || !sameJson(result.attachment.rect, request.rect)
    || !exact(result.evidence, EVIDENCE_KEYS) || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !Array.isArray(result.limitations) || !sameJson(result.limitations, LIMITATIONS)
    || !validArtifact(result.artifact, { documentId, sourceSha256, request })) invalid('The local host returned an invalid file/audio attachment result.');
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validatePdfFileAudioAttachmentResult(result, context) {
  const request = normalizeRequest(context.request);
  validateResult(result, { ...context, request });
  return deepFreeze({
    kind: result.kind,
    sourceDigest: result.sourceDigest,
    artifact: { ...result.artifact, operation: { ...result.artifact.operation } },
    attachment: { ...result.attachment, rect: { ...result.attachment.rect } },
    evidence: { ...result.evidence },
    limitations: [...result.limitations],
  });
}

export function createFileAudioAttachmentEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('File/audio attachment endpoints require a JSON transport.');
  function addFileAudioAttachment(documentId, request, options = {}) {
    const optionKeys = options?.signal === undefined ? [] : ['signal'];
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exact(options, optionKeys)
      || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      throw new TypeError('PDF file/audio attachment options are invalid.');
    }
    let normalized;
    try { normalized = normalizeRequest(request); } catch { throw new TypeError('PDF file/audio attachment options are invalid.'); }
    return json(`/api/documents/${encodeURIComponent(documentId)}/file-audio-attachment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalized), signal: options.signal,
    }).then((body) => validatePdfFileAudioAttachmentResult(body?.result, {
      documentId, sourceSha256: normalized.sourceSha256, request: normalized,
    }));
  }
  return Object.freeze({ addFileAudioAttachment, runFileAudioAttachment: addFileAudioAttachment });
}

export const createPdfFileAudioAttachmentEndpoints = createFileAudioAttachmentEndpoints;
