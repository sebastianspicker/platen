import { basename, extname } from 'node:path';
import { HostError } from '../host-error.mjs';
import {
  PDF_FILE_AUDIO_ATTACHMENT_PROFILE,
  normalizePdfFileAudioAttachment,
} from '../pdf-file-audio-attachment-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
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

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function sameJson(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function validOperation(operation, { documentId, sourceSha256, request, outputSha256 }) {
  return exact(operation, OPERATION_KEYS)
    && operation.schemaVersion === 1 && UUID.test(operation.id ?? '')
    && operation.type === 'pdf-file-audio-attachment'
    && Array.isArray(operation.inputs) && operation.inputs.length === 2
    && exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === documentId
    && operation.inputs[0].sha256 === sourceSha256
    && operation.inputs[0].role === 'source'
    && exact(operation.inputs[1], ['assetId', 'sha256', 'role'])
    && operation.inputs[1].assetId === request.assetId
    && operation.inputs[1].sha256 === request.assetSha256
    && operation.inputs[1].role === 'attachment'
    && sameJson(operation.parameters, request)
    && exact(operation.expected, [
      'page', 'sourcePrefixPreserved', 'sourceUnchanged', 'annotationSubtype', 'outputSha256',
    ])
    && operation.expected.page === request.page
    && operation.expected.sourcePrefixPreserved === true
    && operation.expected.sourceUnchanged === true
    && operation.expected.annotationSubtype === 'FileAttachment'
    && operation.expected.outputSha256 === outputSha256
    && exact(operation.validation, ['passed', 'validators', 'outputSha256'])
    && operation.validation.passed === true
    && Array.isArray(operation.validation.validators)
    && sameJson(operation.validation.validators, VALIDATORS)
    && operation.validation.outputSha256 === outputSha256
    && canonicalTimestamp(operation.completedAt);
}

function validArtifact(artifact, { documentId, sourceSha256, request }) {
  if (!exact(artifact, ARTIFACT_KEYS)
    || !UUID.test(artifact.id ?? '') || artifact.id === documentId
    || artifact.documentId !== documentId || typeof artifact.displayName !== 'string'
    || !artifact.displayName.endsWith('-attachment.pdf')
    || artifact.displayName.includes('/') || artifact.displayName.includes('\\')
    || artifact.mediaType !== 'application/pdf' || !Number.isSafeInteger(artifact.size)
    || artifact.size < 64 || artifact.size > 145 * 1024 * 1024
    || !SHA256.test(artifact.sha256 ?? '') || artifact.sha256 === sourceSha256
    || !canonicalTimestamp(artifact.createdAt)
    || !validOperation(artifact.operation, {
      documentId, sourceSha256, request, outputSha256: artifact.sha256,
    })) return false;
  return true;
}

function validResult(result, { documentId, sourceSha256, request, sourceDisplayName }) {
  const expectedDisplayName = `${basename(sourceDisplayName, extname(sourceDisplayName))}-attachment.pdf`;
  return exact(result, ['kind', 'sourceDigest', 'artifact', 'attachment', 'evidence', 'limitations'])
    && result.kind === 'pdf-file-audio-attachment'
    && result.sourceDigest === sourceSha256
    && exact(result.attachment, [
      'assetId', 'assetSha256', 'mediaType', 'extension', 'page', 'rect',
    ])
    && result.attachment.assetId === request.assetId
    && result.attachment.assetSha256 === request.assetSha256
    && result.attachment.mediaType === request.mediaType
    && result.attachment.extension === request.extension
    && result.attachment.page === request.page
    && sameJson(result.attachment.rect, request.rect)
    && exact(result.evidence, EVIDENCE_KEYS)
    && EVIDENCE_KEYS.every((key) => result.evidence[key] === true)
    && Array.isArray(result.limitations) && sameJson(result.limitations, LIMITATIONS)
    && validArtifact(result.artifact, { documentId, sourceSha256, request })
    && result.artifact.displayName === expectedDisplayName;
}

async function cleanupUntrustedArtifact(store, result, documentId, sourceSha256) {
  const returned = result?.artifact;
  if (typeof returned?.id !== 'string' || typeof store?.getArtifact !== 'function'
    || typeof store.deleteArtifact !== 'function') return;
  let retained;
  try { retained = await store.getArtifact(returned.id); } catch { return; }
  const sourceInput = retained?.operation?.inputs?.find((input) => input?.documentId === documentId);
  if (!retained || retained.id !== returned.id || retained.documentId !== documentId
    || sourceInput?.sha256 !== sourceSha256
    || retained.operation?.type !== 'pdf-file-audio-attachment'
    || retained.operation?.validation?.outputSha256 !== retained.sha256) return;
  await store.deleteArtifact(retained.id).catch(() => {});
}

export async function handleFileAudioAttachmentRoute(context) {
  if (context.operation !== 'file-audio-attachment') return false;
  const {
    request, response, url, documentId, processing, store, fileAudioAttachments,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'File/audio attachment does not accept query parameters.', 400);
  if (!fileAudioAttachments || typeof fileAudioAttachments.add !== 'function') throw new HostError('PDF_FILE_AUDIO_ATTACHMENT_UNAVAILABLE', 'The local file/audio attachment service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  const keys = ['profile', 'sourceSha256', 'assetId', 'assetSha256', 'mediaType', 'extension', 'page', 'rect'];
  if (!exactJsonObject(body, keys)) throw new HostError('INVALID_PDF_FILE_AUDIO_ATTACHMENT_OPTIONS', 'File/audio attachment requires the exact source and trusted asset fields.', 400);
  let value;
  try { value = normalizePdfFileAudioAttachment(body); } catch (error) { throw new HostError('INVALID_PDF_FILE_AUDIO_ATTACHMENT_OPTIONS', 'File/audio attachment options are outside the bounded contract.', 400, { cause: error }); }
  let source;
  try { source = store.getDocument(documentId); } catch (error) { throw new HostError('SOURCE_DOCUMENT_UNAVAILABLE', 'The file/audio attachment source document is unavailable.', 404, { cause: error }); }
  if (source.sha256 !== value.sourceSha256) throw new HostError('SOURCE_VERSION_MISMATCH', 'The file/audio attachment source digest does not match the current document.', 409);
  const result = await fileAudioAttachments.add(documentId, value, { sourceSha256: value.sourceSha256, signal: processing.signal });
  if (!validResult(result, { documentId, sourceSha256: value.sourceSha256, request: value, sourceDisplayName: source.displayName })) {
    await cleanupUntrustedArtifact(store, result, documentId, value.sourceSha256);
    throw new HostError('PDF_FILE_AUDIO_ATTACHMENT_RESULT_INVALID', 'The file/audio attachment service returned an invalid retained result.', 502);
  }
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}

export { validResult as validateFileAudioAttachmentResult };
