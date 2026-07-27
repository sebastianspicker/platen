import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  INCREMENTAL_METADATA_AFTER_FILES, INCREMENTAL_METADATA_BEFORE_FILES,
  assertIncrementalMetadataFileIdentity, assertIncrementalMetadataRendersMatch,
  assertIncrementalMetadataWorkspace, incrementalMetadataFileIdentity,
  incrementalMetadataRunOptions, inspectIncrementalMetadataContent,
  inspectIncrementalMetadataEnvelope, readStableIncrementalMetadataOutput,
  writePrivateIncrementalMetadataOutput,
} from './pdf-incremental-metadata-validation.mjs';
import { HostError } from './host-error.mjs';
import { ANNOTATION_FLATTEN_PROFILE } from './pdf-annotation-flatten-contract.mjs';

export const MAX_PDF_ANNOTATION_FLATTEN_SOURCE_BYTES = 64 * 1024 * 1024;
export const PDF_ANNOTATION_FLATTEN_BEFORE_FILES = INCREMENTAL_METADATA_BEFORE_FILES;
export const PDF_ANNOTATION_FLATTEN_AFTER_FILES = INCREMENTAL_METADATA_AFTER_FILES;
export const pdfAnnotationFlattenFileIdentity = incrementalMetadataFileIdentity;

const PROOF_KEYS = Object.freeze([
  'profile', 'sourceBytes', 'outputBytes', 'sourceSha256', 'outputSha256',
  'sourcePrefixPreserved', 'closedClassicRevision', 'priorRevisionsAbsent',
  'revisionCount', 'annotationRemoved', 'removedReferenceUnresolvable',
  'appearancePreserved', 'appearancePromotedToPageContent', 'rootPreserved',
  'infoPreserved', 'idPolicy',
]);
const STABLE = Object.freeze([
  'pageCount', 'title', 'author', 'subject', 'keywords', 'creator', 'producer',
  'createdAt', 'modifiedAt', 'tagged', 'userProperties', 'suspects', 'form',
  'javascript', 'encrypted', 'pageSize', 'pageRotation', 'optimized', 'pdfVersion',
]);

function fail(code, message, status = 502) { throw new HostError(code, message, status); }

function rethrowInspection(error, phase) {
  if (error?.code === 'INCREMENTAL_METADATA_POPPLER_WARNING') {
    fail('PDF_ANNOTATION_FLATTEN_POPPLER_WARNING', `Poppler reported a warning while validating annotation flatten ${phase}.`, 422);
  }
  throw error;
}

export { incrementalMetadataRunOptions as pdfAnnotationFlattenRunOptions };

export async function inspectPdfAnnotationFlattenEnvelope(poppler, input, workspace, signal) {
  try { return await inspectIncrementalMetadataEnvelope(poppler, input, workspace, signal); } catch (error) { return rethrowInspection(error, 'document structure'); }
}
export async function inspectPdfAnnotationFlattenContent(poppler, input, workspace, signal, pageCount) {
  try { return await inspectIncrementalMetadataContent(poppler, input, workspace, signal, pageCount); } catch (error) { return rethrowInspection(error, 'page content'); }
}
export async function assertPdfAnnotationFlattenWorkspace(workspace, expected) {
  try { return await assertIncrementalMetadataWorkspace(workspace, expected); } catch { return fail('PDF_ANNOTATION_FLATTEN_WORKSPACE_INVALID', 'Annotation flatten changed its private workspace topology.'); }
}
export async function writePrivatePdfAnnotationFlattenOutput(path, bytes) {
  try { return await writePrivateIncrementalMetadataOutput(path, bytes); } catch { return fail('PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID', 'The compact annotation-flatten output could not be staged privately.'); }
}
export async function readStablePdfAnnotationFlatten(path, maximumBytes) {
  try { return await readStableIncrementalMetadataOutput(path, maximumBytes); } catch { return fail('PDF_ANNOTATION_FLATTEN_WORKSPACE_INVALID', 'An annotation-flatten workspace file was not stable and private.'); }
}
export async function assertPdfAnnotationFlattenFileIdentity(path, expected) {
  try { return await assertIncrementalMetadataFileIdentity(path, expected); } catch { return fail('PDF_ANNOTATION_FLATTEN_WORKSPACE_INVALID', 'An annotation-flatten workspace file changed during validation.'); }
}
export async function assertPdfAnnotationFlattenRendersMatch(options) {
  try { return await assertIncrementalMetadataRendersMatch(options); } catch (error) {
    return fail(error?.code === 'INCREMENTAL_METADATA_POPPLER_WARNING' ? 'PDF_ANNOTATION_FLATTEN_POPPLER_WARNING' : 'PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID', error?.code === 'INCREMENTAL_METADATA_POPPLER_WARNING' ? 'Poppler reported a warning while validating annotation flatten.' : 'Annotation flatten changed a fixed validation render.', error?.code === 'INCREMENTAL_METADATA_POPPLER_WARNING' ? 422 : 502);
  }
}

export function pdfAnnotationFlattenSourceSupported(envelope, signatures) {
  return Number.isSafeInteger(envelope.inspection.pageCount)
    && envelope.inspection.pageCount >= 1 && envelope.inspection.pageCount <= 100
    && String(envelope.inspection.encrypted).toLowerCase() === 'no'
    && String(envelope.inspection.form).toLowerCase() === 'none'
    && String(envelope.inspection.javascript).toLowerCase() === 'no'
    && String(envelope.inspection.tagged).toLowerCase() === 'no'
    && envelope.xmp.present === false && envelope.attachments.length === 0
    && envelope.urls.length === 0 && signatures.status === 'unsigned'
    && signatures.signatureCount === 0;
}
export function pdfAnnotationFlattenEnvelopeMatches(source, output) {
  return STABLE.every((field) => source.inspection[field] === output.inspection[field])
    && isDeepStrictEqual(source.custom, output.custom)
    && isDeepStrictEqual(source.xmp, output.xmp)
    && isDeepStrictEqual(source.attachments, output.attachments)
    && isDeepStrictEqual(source.urls, output.urls);
}
export function pdfAnnotationFlattenContentMatches(source, output) { return isDeepStrictEqual(source, output); }
export function assertPdfAnnotationFlattenProof(proof, sourceBytes, outputBytes, request) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
  const sourceSha256 = Buffer.isBuffer(sourceBytes) ? createHash('sha256').update(sourceBytes).digest('hex') : '';
  const outputSha256 = Buffer.isBuffer(outputBytes) ? createHash('sha256').update(outputBytes).digest('hex') : '';
  const valid = keys.length === PROOF_KEYS.length && keys.every((key, index) => key === PROOF_KEYS[index])
    && proof.profile === ANNOTATION_FLATTEN_PROFILE && request.profile === proof.profile
    && proof.sourceBytes === sourceBytes.length && proof.outputBytes === outputBytes.length
    && proof.sourceSha256 === sourceSha256 && proof.outputSha256 === outputSha256
    && proof.sourcePrefixPreserved === false && proof.closedClassicRevision === true
    && proof.priorRevisionsAbsent === true && proof.revisionCount === 1
    && proof.annotationRemoved === true && proof.removedReferenceUnresolvable === true
    && proof.appearancePreserved === true && proof.appearancePromotedToPageContent === true
    && proof.rootPreserved === true && proof.infoPreserved === true
    && ['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy);
  if (!valid) fail('PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID', 'The annotation-flatten proof did not match the fixed compact-output contract.');
  return proof;
}
