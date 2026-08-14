import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import {
  INCREMENTAL_METADATA_AFTER_FILES, INCREMENTAL_METADATA_BEFORE_FILES,
  assertIncrementalMetadataFileIdentity, assertIncrementalMetadataRendersMatch,
  assertIncrementalMetadataWorkspace, incrementalMetadataFileIdentity,
  incrementalMetadataRunOptions, inspectIncrementalMetadataContent,
  inspectIncrementalMetadataEnvelope, readStableIncrementalMetadataOutput,
  writePrivateIncrementalMetadataOutput,
} from './pdf-incremental-metadata-validation.mjs';
import { HostError } from './host-error.mjs';
import { PDF_JAVASCRIPT_REMOVAL_PROFILE } from './pdf-javascript-removal-contract.mjs';

export const MAX_PDF_JAVASCRIPT_REMOVAL_SOURCE_BYTES = 64 * 1024 * 1024;
export const PDF_JAVASCRIPT_REMOVAL_BEFORE_FILES = INCREMENTAL_METADATA_BEFORE_FILES;
export const PDF_JAVASCRIPT_REMOVAL_AFTER_FILES = INCREMENTAL_METADATA_AFTER_FILES;
const KEYS = Object.freeze(['profile', 'sourceBytes', 'outputBytes', 'sourceSha256', 'outputSha256', 'removedLocus', 'removedObjectCount', 'closedClassicRevision', 'priorRevisionsAbsent', 'javascriptSurfacesAbsent', 'removedReferencesUnresolvable', 'rootPreserved', 'infoPreserved', 'idPolicy']);
const STABLE = Object.freeze(['pageCount', 'title', 'author', 'subject', 'keywords', 'creator', 'producer', 'createdAt', 'modifiedAt', 'tagged', 'userProperties', 'suspects', 'form', 'encrypted', 'pageSize', 'pageRotation', 'optimized', 'pdfVersion']);
const REMOVAL_LOCI = Object.freeze(['open-action', 'names']);
const SAFETY_FLAGS = Object.freeze(['closedClassicRevision', 'priorRevisionsAbsent', 'javascriptSurfacesAbsent', 'removedReferencesUnresolvable', 'rootPreserved', 'infoPreserved']);
const ID_POLICIES = Object.freeze(['absent', 'permanent-preserved-changing-updated']);
function fail(code, message, status = 502) { throw new HostError(code, message, status); }
export { incrementalMetadataRunOptions as pdfJavaScriptRemovalRunOptions };
export const pdfJavaScriptRemovalFileIdentity = incrementalMetadataFileIdentity;

function rethrowInspection(error, phase) {
  if (error?.code === 'INCREMENTAL_METADATA_POPPLER_WARNING') {
    return fail(
      'PDF_JAVASCRIPT_REMOVAL_POPPLER_WARNING',
      `Poppler reported a warning while validating JavaScript-removal ${phase}.`,
      422,
    );
  }
  throw error;
}

export async function inspectPdfJavaScriptRemovalEnvelope(poppler, input, workspace, signal) {
  try {
    return await inspectIncrementalMetadataEnvelope(poppler, input, workspace, signal);
  } catch (error) {
    return rethrowInspection(error, 'document structure');
  }
}

export async function inspectPdfJavaScriptRemovalContent(
  poppler,
  input,
  workspace,
  signal,
  pageCount,
) {
  try {
    return await inspectIncrementalMetadataContent(
      poppler,
      input,
      workspace,
      signal,
      pageCount,
    );
  } catch (error) {
    return rethrowInspection(error, 'page content');
  }
}

export async function assertPdfJavaScriptRemovalWorkspace(workspace, expected) {
  try { return await assertIncrementalMetadataWorkspace(workspace, expected); } catch {
    return fail('PDF_JAVASCRIPT_REMOVAL_WORKSPACE_INVALID', 'JavaScript removal changed its private workspace topology.');
  }
}
export async function writePrivatePdfJavaScriptRemovalOutput(path, bytes) {
  try { return await writePrivateIncrementalMetadataOutput(path, bytes); } catch {
    return fail('PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID', 'The compact JavaScript-removal output could not be staged privately.');
  }
}
export async function readStablePdfJavaScriptRemoval(path, maximumBytes) {
  try { return await readStableIncrementalMetadataOutput(path, maximumBytes); } catch {
    return fail('PDF_JAVASCRIPT_REMOVAL_WORKSPACE_INVALID', 'A JavaScript-removal workspace file was not stable and private.');
  }
}
export async function assertPdfJavaScriptRemovalFileIdentity(path, expected) {
  try { return await assertIncrementalMetadataFileIdentity(path, expected); } catch {
    return fail('PDF_JAVASCRIPT_REMOVAL_WORKSPACE_INVALID', 'A JavaScript-removal workspace file changed during validation.');
  }
}
export async function assertPdfJavaScriptRemovalRendersMatch(options) {
  try { return await assertIncrementalMetadataRendersMatch(options); } catch (error) {
    const warning = error?.code === 'INCREMENTAL_METADATA_POPPLER_WARNING';
    return fail(warning ? 'PDF_JAVASCRIPT_REMOVAL_POPPLER_WARNING' : 'PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID', warning ? 'Poppler reported a warning while validating JavaScript removal.' : 'JavaScript removal changed a fixed validation render.', warning ? 422 : 502);
  }
}

export function pdfJavaScriptRemovalSourceSupported(envelope, signatures) {
  return envelope.inspection.pageCount >= 1 && envelope.inspection.pageCount <= 100
    && String(envelope.inspection.encrypted).toLowerCase() === 'no'
    && String(envelope.inspection.form).toLowerCase() === 'none'
    && String(envelope.inspection.javascript).toLowerCase() === 'yes'
    && envelope.xmp.present === false && envelope.attachments.length === 0 && envelope.urls.length === 0
    && signatures.status === 'unsigned' && signatures.signatureCount === 0;
}
export function pdfJavaScriptRemovalEnvelopeMatches(source, output) {
  return STABLE.every((field) => source.inspection[field] === output.inspection[field])
    && String(output.inspection.javascript).toLowerCase() === 'no'
    && isDeepStrictEqual(source.custom, output.custom) && isDeepStrictEqual(source.xmp, output.xmp)
    && isDeepStrictEqual(source.attachments, output.attachments) && isDeepStrictEqual(source.urls, output.urls);
}
export function pdfJavaScriptRemovalContentMatches(source, output) { return isDeepStrictEqual(source, output); }

function proofKeys(proof) {
  return proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
}

function proofByteFacts(sourceBytes, outputBytes) {
  const sourceLength = Buffer.isBuffer(sourceBytes) ? sourceBytes.length : -1;
  const outputLength = Buffer.isBuffer(outputBytes) ? outputBytes.length : -1;
  const sourceSha256 = Buffer.isBuffer(sourceBytes) ? createHash('sha256').update(sourceBytes).digest('hex') : '';
  const outputSha256 = Buffer.isBuffer(outputBytes) ? createHash('sha256').update(outputBytes).digest('hex') : '';
  return { sourceLength, outputLength, sourceSha256, outputSha256 };
}

function proofKeysMatch(keys) {
  return keys.length === KEYS.length && keys.every((key, index) => key === KEYS[index]);
}

function proofProfileMatches(proof, request) {
  return proof.profile === PDF_JAVASCRIPT_REMOVAL_PROFILE && request.profile === proof.profile;
}

function proofByteFactsMatch(proof, facts) {
  return proof.sourceBytes === facts.sourceLength && proof.outputBytes === facts.outputLength
    && proof.sourceSha256 === facts.sourceSha256 && proof.outputSha256 === facts.outputSha256;
}

function proofRemovalMatches(proof) {
  return REMOVAL_LOCI.includes(proof.removedLocus) && Number.isSafeInteger(proof.removedObjectCount)
    && proof.removedObjectCount === (proof.removedLocus === 'names' ? 2 : 1);
}

function proofSafetyFlagsMatch(proof) {
  return SAFETY_FLAGS.every((key) => proof[key] === true);
}

function proofIdPolicyMatches(proof) {
  return ID_POLICIES.includes(proof.idPolicy);
}

function assertProofCondition(matches) {
  if (!matches) fail('PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID', 'The JavaScript-removal proof did not match the fixed compact-output contract.');
}

export function assertPdfJavaScriptRemovalProof(proof, sourceBytes, outputBytes, request) {
  const keys = proofKeys(proof);
  const facts = proofByteFacts(sourceBytes, outputBytes);
  assertProofCondition(proofKeysMatch(keys));
  assertProofCondition(proofProfileMatches(proof, request));
  assertProofCondition(proofByteFactsMatch(proof, facts));
  assertProofCondition(proofRemovalMatches(proof));
  assertProofCondition(proofSafetyFlagsMatch(proof));
  assertProofCondition(proofIdPolicyMatches(proof));
  return proof;
}
