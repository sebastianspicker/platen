import { basename } from 'node:path';
import { normalizePdfTextReflowRequest, PDF_TEXT_REFLOW_PROFILE } from '../../host/pdf-text-reflow-contract.mjs';

const REQUEST_KEYS = Object.freeze([
  'page', 'streamRef', 'lineTokenIndices', 'lineWidth', 'originalTextSha256', 'replacementText',
]);
const ARTIFACT_KEYS = Object.freeze([
  'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

function dense(value, minimum, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_, index) => descriptors[index])
    .every((descriptor) => descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
}

function validRequestFile(value) {
  if (!exact(value, REQUEST_KEYS) || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 10_000
    || !exact(value.streamRef, ['object', 'generation'])
    || !Number.isSafeInteger(value.streamRef.object) || value.streamRef.object < 1 || value.streamRef.object > 1_000_000
    || !Number.isSafeInteger(value.streamRef.generation) || value.streamRef.generation < 0 || value.streamRef.generation > 65_535
    || !dense(value.lineTokenIndices, 2, 32)
    || value.lineTokenIndices.some((item, index) => !Number.isSafeInteger(item) || item < 0 || item > 200_000
      || (index > 0 && item <= value.lineTokenIndices[index - 1]))
    || !Number.isSafeInteger(value.lineWidth) || value.lineWidth < 4 || value.lineWidth > 128
    || !SHA256.test(value.originalTextSha256 ?? '') || typeof value.replacementText !== 'string'
    || value.replacementText.length < 1 || Buffer.byteLength(value.replacementText, 'ascii') > 4_096
    || !/^[\x20-\x7e]+$/u.test(value.replacementText) || /[\\()]/u.test(value.replacementText)
    || value.replacementText.trim() !== value.replacementText || /\s{2,}/u.test(value.replacementText)) return false;
  return true;
}

function sameJson(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function validRetainedArtifact(candidate, retained, document) {
  if (!exact(candidate, ARTIFACT_KEYS) || !retained || typeof retained !== 'object'
    || !UUID.test(candidate.id ?? '') || candidate.documentId !== document.id
    || candidate.displayName !== 'text-reflow.pdf' || candidate.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(candidate.size) || candidate.size < 64
    || !SHA256.test(candidate.sha256 ?? '') || candidate.sha256 === document.sha256
    || !sameJson(candidate.operation, retained.operation)
    || candidate.id !== retained.id || candidate.documentId !== retained.documentId
    || candidate.mediaType !== retained.mediaType || candidate.size !== retained.size
    || candidate.sha256 !== retained.sha256 || candidate.displayName !== retained.displayName
    || typeof retained.filePath !== 'string' || !retained.filePath) return false;
  return true;
}

function privacySafeReceipt(result, output) {
  const artifact = result?.artifact ?? {};
  const proof = result?.proof ?? {};
  return Object.freeze({
    kind: 'pdf-text-reflow',
    profile: PDF_TEXT_REFLOW_PROFILE,
    localOnly: true,
    artifact: Object.freeze({
      id: artifact.id,
      documentId: artifact.documentId,
      displayName: artifact.displayName,
      mediaType: artifact.mediaType,
      size: artifact.size,
      sha256: artifact.sha256,
      createdAt: artifact.createdAt,
      output: basename(output),
    }),
    proof: Object.freeze({
      profile: proof.profile,
      outputSha256: proof.outputSha256,
      sourcePrefixPreserved: proof.sourcePrefixPreserved,
      page: proof.page,
      streamReference: proof.streamReference,
      lineCount: proof.lineCount,
      lineWidth: proof.lineWidth,
      fixedSlotReflow: proof.fixedSlotReflow,
      textPositionsPreserved: proof.textPositionsPreserved,
      typographyPreserved: proof.typographyPreserved,
      streamByteLengthPreserved: proof.streamByteLengthPreserved,
      revisionCount: proof.revisionCount,
      changedObjectCount: proof.changedObjectCount,
    }),
    limitations: Object.freeze(Array.isArray(result?.limitations) ? [...result.limitations] : []),
  });
}

export async function runTextReflowCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const service = application.textReflow;
  if (!service || typeof service.reflow !== 'function') {
    runtime.fail('CLI_TEXT_REFLOW_UNAVAILABLE', 'Text reflow is unavailable.');
  }
  const selected = await runtime.readLocalInputBytes(command.requestPath, {
    minimumBytes: 2,
    maximumBytes: 128 * 1024,
    extension: '.json',
    signal,
  });
  let request;
  try {
    let parsed;
    try { parsed = JSON.parse(selected.bytes.toString('utf8')); } catch { parsed = null; }
    if (!validRequestFile(parsed)) {
      runtime.fail('CLI_INVALID_TEXT_REFLOW_REQUEST', 'The text-reflow request file is invalid or outside the bounded contract.');
    }
    request = normalizePdfTextReflowRequest({
      ...parsed,
      profile: PDF_TEXT_REFLOW_PROFILE,
      sourceSha256: document.sha256,
    });
  } catch (error) {
    if (error?.code?.startsWith?.('CLI_')) throw error;
    runtime.fail('CLI_INVALID_TEXT_REFLOW_REQUEST', 'The text-reflow request file is invalid or outside the bounded contract.');
  } finally {
    selected.bytes.fill(0);
  }
  runtime.cancelled(signal);
  let result = null;
  let trustedArtifactId = null;
  let operationError = null;
  try {
    result = await service.reflow(document.id, request, { signal });
    runtime.cancelled(signal);
    const candidate = result?.artifact;
    if (!candidate?.id) runtime.fail('CLI_TEXT_REFLOW_RECEIPT_INVALID', 'Text-reflow delivery did not return a retained artifact.');
    const retained = application.store.getArtifact(candidate.id);
    if (!validRetainedArtifact(candidate, retained, document)) {
      runtime.fail('CLI_TEXT_REFLOW_RECEIPT_INVALID', 'The retained text-reflow artifact does not match the validated result.');
    }
    trustedArtifactId = retained.id;
    await runtime.copyExclusive(retained.filePath, command.output, signal);
    runtime.cancelled(signal);
    await runtime.emit(stdout, privacySafeReceipt(result, command.output));
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  if (trustedArtifactId) {
    try { await application.store.deleteArtifact(trustedArtifactId); } catch (error) { cleanupError = error; }
  }
  if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], 'Text-reflow delivery and artifact cleanup failed.');
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
}

export { validRequestFile as validateTextReflowRequestFile, privacySafeReceipt };

