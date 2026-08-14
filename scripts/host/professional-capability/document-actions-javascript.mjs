import { validatePdfJavaScriptRemovalResult } from '../../../src/core/pdf-javascript-removal-contract.js';
import { PDF_JAVASCRIPT_REMOVAL_PROFILE } from '../pdf-javascript-removal-contract.mjs';
import { result, fail, requireBytes, sha256 } from './support.mjs';

const FAMILY = 'content-editing';
const SHA256 = /^[0-9a-f]{64}$/u;

function request(ctx) {
  if (typeof ctx.documentId !== 'string' || ctx.documentId.trim().length < 1) {
    fail('DOCUMENT_ACTIONS_JAVASCRIPT_DOCUMENT_REQUIRED', 'JavaScript removal requires an explicit source document identity.', 400);
  }
  if (!SHA256.test(String(ctx.sourceSha256 ?? ''))) {
    fail('DOCUMENT_ACTIONS_JAVASCRIPT_SOURCE_DIGEST_REQUIRED', 'JavaScript removal requires the current lowercase source SHA-256.', 400);
  }
  if (ctx.profile !== PDF_JAVASCRIPT_REMOVAL_PROFILE) {
    fail('INVALID_DOCUMENT_ACTIONS_JAVASCRIPT_OPTIONS', 'JavaScript removal requires the fixed removal profile.', 400);
  }
  if (ctx.signal !== undefined && !(ctx.signal instanceof AbortSignal)) {
    fail('INVALID_DOCUMENT_ACTIONS_JAVASCRIPT_OPTIONS', 'JavaScript removal supports only an optional AbortSignal.', 400);
  }
  if (ctx.signal?.aborted) {
    fail('JOB_CANCELLED', 'JavaScript removal was cancelled.', 499);
  }
  return Object.freeze({
    documentId: ctx.documentId,
    sourceSha256: ctx.sourceSha256,
    signal: ctx.signal,
  });
}

function authority(ctx) {
  if (!ctx.javascriptRemoval || typeof ctx.javascriptRemoval.remove !== 'function') {
    fail('DOCUMENT_ACTIONS_JAVASCRIPT_UNAVAILABLE', 'The local JavaScript-removal authority is unavailable.', 503);
  }
  if (typeof ctx.readArtifact !== 'function') {
    fail('DOCUMENT_ACTIONS_JAVASCRIPT_READBACK_UNAVAILABLE', 'JavaScript removal requires retained-artifact readback.', 503);
  }
  return ctx.javascriptRemoval;
}

function receipt(receiptValue, boundary) {
  try {
    const transportReceipt = JSON.parse(JSON.stringify(receiptValue));
    return validatePdfJavaScriptRemovalResult(transportReceipt, {
      documentId: boundary.documentId,
      sourceSha256: boundary.sourceSha256,
    });
  } catch (error) {
    fail(
      'DOCUMENT_ACTIONS_JAVASCRIPT_RECEIPT_INVALID',
      'The JavaScript-removal authority returned an invalid source-bound receipt.',
      502,
      error,
    );
  }
}

/** Remove one admitted document-level JavaScript locus through the retained local authority. */
export async function executeDocumentActionsJavascript(ctx = {}) {
  const boundary = request(ctx);
  const service = authority(ctx);
  let serviceReceipt;
  try {
    serviceReceipt = await service.remove(
      boundary.documentId,
      { profile: PDF_JAVASCRIPT_REMOVAL_PROFILE },
      { sourceSha256: boundary.sourceSha256, signal: boundary.signal },
    );
  } catch (error) {
    if (error?.code) throw error;
    fail('DOCUMENT_ACTIONS_JAVASCRIPT_SERVICE_FAILED', 'The local JavaScript-removal authority failed.', 502, error);
  }
  const validated = receipt(serviceReceipt, boundary);
  let artifactBytes;
  try {
    artifactBytes = requireBytes(
      await ctx.readArtifact(validated.artifact),
      'javascriptRemovalArtifact',
      { min: 64, max: 129 * 1024 * 1024 },
    );
    if (artifactBytes.length !== validated.artifact.size
      || sha256(artifactBytes) !== validated.artifact.sha256) {
      fail('DOCUMENT_ACTIONS_JAVASCRIPT_OUTPUT_INVALID', 'The retained JavaScript-removal artifact does not match its validated digest.', 502);
    }
    if (boundary.signal?.aborted) {
      fail('JOB_CANCELLED', 'JavaScript removal was cancelled.', 499);
    }
  } finally {
    artifactBytes?.fill(0);
  }
  return result('document.actions-javascript', {
    familyId: FAMILY,
    method: 'production-pdf-javascript-removal-service',
    sourceSha256: boundary.sourceSha256,
    outputSha256: validated.artifact.sha256,
    artifact: validated.artifact,
    removal: validated.removal,
    evidence: validated.evidence,
    limitations: validated.limitations,
    allowExecution: false,
    allowAuthoring: false,
    retainedBoundaryValidated: true,
    serviceReceipt: validated,
  });
}
