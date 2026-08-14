import { isDeepStrictEqual } from 'node:util';
import { writePdfTextEdit, inspectPdfTextEdit } from '../pdf-text-edit-writer.mjs';
import { PDF_TEXT_EDIT_PROFILE } from '../pdf-text-edit-contract.mjs';
import { fail, requireBytes, requireString, result, sha256 } from './support.mjs';
import { HostError } from '../host-error.mjs';
import { editableTextPdf, digest } from './fixtures.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function cancelled(signal) {
  if (!signal?.aborted) return null;
  if (signal.reason instanceof Error && signal.reason.code === 'JOB_CANCELLED' && signal.reason.status === 499) {
    return signal.reason;
  }
  return new HostError('JOB_CANCELLED', 'The text-edit operation was cancelled.', 499, {
    cause: signal.reason,
  });
}

function normalizeTextEditRereadFailure(cause) {
  return cause?.code === 'TEXT_EDIT_ARTIFACT_READBACK_FAILED'
    ? cause
    : new HostError('TEXT_EDIT_ARTIFACT_READBACK_FAILED', 'The retained text-edit artifact could not be reread.', 502, { cause });
}

function localTextEditRequest(ctx = {}) {
  const find = requireString(ctx.find ?? 'hello world', 'find', { min: 1, max: 200 });
  const replace = requireString(ctx.replace ?? find.toUpperCase(), 'replace', { min: 1, max: 200 });
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? editableTextPdf(find), 'sourcePdf');
  if (Buffer.byteLength(find, 'latin1') !== Buffer.byteLength(replace, 'latin1')) {
    fail('INVALID_TEXT_EDIT', 'Find/replace must be equal length for the pure writer subset.', 400);
  }
  return {
    source,
    request: {
      profile: PDF_TEXT_EDIT_PROFILE,
      page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
      find,
      replace,
    },
    find,
    replace,
  };
}

function textEditProductionInput(ctx = {}) {
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf');
  const sourceSha256 = digest(source);
  if (!SHA256.test(ctx.sourceSha256 ?? '') || ctx.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The supplied text-edit source digest does not match the source PDF.', 409);
  }
  if (!UUID.test(ctx.documentId ?? '')) {
    fail('TEXT_EDIT_DOCUMENT_REQUIRED', 'Text editing requires an explicit document identity.', 400);
  }
  const service = ctx.textEdit ?? ctx.pdfTextEdit;
  if (!service) {
    fail('TEXT_EDIT_SERVICE_UNAVAILABLE', 'The production text-edit service is unavailable.', 503);
  }
  const method = ctx.capabilityId === 'edit.find-replace' ? 'findReplace' : 'edit';
  const serviceMethod = typeof service?.[method] === 'function'
    ? method
    : method === 'findReplace' && typeof service?.replace === 'function'
      ? 'replace'
      : null;
  if (!serviceMethod) {
    fail('TEXT_EDIT_SERVICE_UNAVAILABLE', `The production text-edit service does not support ${ctx.capabilityId}.`, 503);
  }
  const readArtifact = typeof ctx.readArtifact === 'function'
    ? ctx.readArtifact
    : typeof service.readArtifact === 'function'
      ? service.readArtifact.bind(service)
      : null;
  if (!readArtifact) {
    fail('TEXT_EDIT_ARTIFACT_READBACK_REQUIRED', 'Text editing requires an explicit retained artifact reread authority.', 503);
  }
  const find = requireString(ctx.find ?? 'hello world', 'find', { min: 1, max: 200 });
  const replace = requireString(ctx.replace ?? find.toUpperCase(), 'replace', { min: 1, max: 200 });
  if (Buffer.byteLength(find, 'latin1') !== Buffer.byteLength(replace, 'latin1')) {
    fail('INVALID_TEXT_EDIT', 'Find/replace must be equal length for the pure writer subset.', 400);
  }
  return {
    source,
    sourceSha256,
    service,
    serviceMethod,
    readArtifact,
    proofInput: {
      profile: PDF_TEXT_EDIT_PROFILE,
      page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
      findSha256: sha256(Buffer.from(find, 'latin1')),
      replaceSha256: sha256(Buffer.from(replace, 'latin1')),
    },
    request: {
      profile: PDF_TEXT_EDIT_PROFILE,
      sourceSha256,
      page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
      find,
      replace,
    },
    find,
    replace,
  };
}

function validateTextEditProof(receipt, { documentId, sourceSha256, proofRequest, artifactBytes }) {
  const artifact = receipt?.artifact;
  const operation = artifact?.operation;
  const proof = receipt?.proof;
  if (!receipt || receipt.kind !== 'pdf-text-edit' || !Array.isArray(receipt.limitations) || receipt.limitations.length < 1
    || !artifact || artifact.mediaType !== 'application/pdf' || !UUID.test(String(artifact.id ?? ''))
    || artifact.documentId !== documentId || artifact.size !== artifactBytes.length
    || !SHA256.test(artifact.sha256 ?? '') || artifact.sha256 === sourceSha256 || !proof) {
    fail('TEXT_EDIT_RECEIPT_INVALID', 'The text-edit production receipt is malformed.');
  }
  if (artifact.sha256 !== sha256(artifactBytes)) {
    fail('TEXT_EDIT_OUTPUT_INVALID', 'The reread text-edit artifact digest does not match the production receipt.');
  }
  if (!operation || operation.type !== 'pdf-text-edit' || operation.validation?.passed !== true
    || operation.parameters?.profile !== PDF_TEXT_EDIT_PROFILE || operation.parameters?.page !== proofRequest.page
    || operation.parameters?.findSha256 !== proofRequest.findSha256 || operation.parameters?.replaceSha256 !== proofRequest.replaceSha256
    || operation.validation?.outputSha256 !== artifact.sha256 || !Array.isArray(operation.inputs)
    || !operation.inputs.some((input) => input?.documentId === documentId
      && input?.sha256 === sourceSha256 && input?.role === 'source')) {
    fail('TEXT_EDIT_RECEIPT_INVALID', 'The text-edit production receipt is not bound to the requested source and artifact.');
  }
  return { artifact, proof };
}

async function aggregateTextEditFailure(context, artifact, failure) {
  if (!artifact || typeof context?.store?.deleteArtifact !== 'function') {
    throw failure;
  }
  try {
    await context.store.deleteArtifact(artifact.id);
  } catch (cleanupFailure) {
    throw new HostError('TEXT_EDIT_CLEANUP_FAILED', 'Production text-edit could not revoke its failed retained artifact.', 500, {
      cause: new AggregateError([failure, cleanupFailure], 'Text-edit cleanup and revocation failed.'),
    });
  }
  throw failure;
}

function localTextEdit(ctx = {}) {
  const resultId = ctx.capabilityId === 'edit.find-replace' ? 'edit.find-replace' : 'edit.text';
  const { source, request, find, replace } = localTextEditRequest(ctx);
  const written = writePdfTextEdit(source, request);
  // Incremental edit preserves the source byte prefix; proof.replacementCount is authoritative.
  if (written.proof?.replacementCount !== 1) {
    fail('TEXT_EDIT_INCOMPLETE', 'Expected exactly one text replacement.', 502);
  }
  if (!written.bytes.includes(Buffer.from(replace, 'latin1'))) {
    fail('TEXT_EDIT_MISSING_REPLACE', 'Replace text not present after edit.', 502);
  }
  return result(resultId, {
    nonPromotable: true,
    method: 'local-pdf-text-edit-writer',
    sourceSha256: digest(source),
    outputSha256: digest(written.bytes),
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    find,
    replace,
    replacementCount: written.proof.replacementCount,
  });
}

export async function textEditWithRetainedBoundary(ctx = {}) {
  const resultId = ctx.capabilityId === 'edit.find-replace' ? 'edit.find-replace' : 'edit.text';
  const explicitProduction = Boolean(ctx.documentId || ctx.textEdit || ctx.pdfTextEdit || ctx.readArtifact);
  if (!explicitProduction) return localTextEdit(ctx);
  const preServiceCancellation = cancelled(ctx.signal);
  if (preServiceCancellation) throw preServiceCancellation;
  const {
    source,
    sourceSha256,
    service,
    serviceMethod,
    readArtifact,
    proofInput,
    request,
    find,
    replace,
  } = textEditProductionInput(ctx);
  let receipt;
  let artifact;
  try {
    receipt = await service[serviceMethod](ctx.documentId, request, { sourceSha256, signal: ctx.signal });
    artifact = receipt?.artifact;
  } catch (error) {
    if (error?.code) throw error;
    fail('TEXT_EDIT_SERVICE_FAILED', 'The production text-edit service failed.', 502, error);
  }
  const postServiceCancellation = cancelled(ctx.signal);
  if (postServiceCancellation) {
    await aggregateTextEditFailure(ctx, artifact, postServiceCancellation);
    throw postServiceCancellation;
  }
  if (!artifact) {
    fail('TEXT_EDIT_RECEIPT_INVALID', 'The text-edit production receipt is missing artifact identity.');
  }
  let artifactBytes;
  try {
    artifactBytes = await readArtifact(artifact);
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED') {
      await aggregateTextEditFailure(ctx, artifact, error);
      throw error;
    }
    const readFailure = normalizeTextEditRereadFailure(error);
    await aggregateTextEditFailure(ctx, artifact, readFailure);
    throw readFailure;
  }
  try {
    artifactBytes = requireBytes(artifactBytes, 'textEditArtifact');
  } catch (error) {
    const readFailure = normalizeTextEditRereadFailure(error);
    await aggregateTextEditFailure(ctx, artifact, readFailure);
    throw readFailure;
  }
  const rereadCancellation = cancelled(ctx.signal);
  if (rereadCancellation) {
    await aggregateTextEditFailure(ctx, artifact, rereadCancellation);
    throw rereadCancellation;
  }
  try {
    const validated = validateTextEditProof(receipt, {
      documentId: ctx.documentId,
      sourceSha256,
      proofRequest: proofInput,
      artifactBytes,
    });
    const independentProof = inspectPdfTextEdit(source, artifactBytes, request);
    if (!isDeepStrictEqual(independentProof, validated.proof)) {
      fail('TEXT_EDIT_RECEIPT_INVALID', 'The independent text-edit proof disagreed with the production receipt.');
    }
    const validationCancellation = cancelled(ctx.signal);
    if (validationCancellation) {
      await aggregateTextEditFailure(ctx, validated.artifact, validationCancellation);
      throw validationCancellation;
    }
    return result(resultId, {
      method: 'production-pdf-text-edit-service',
      sourceSha256,
      artifact: validated.artifact,
      serviceReceipt: receipt,
      outputSha256: validated.artifact.sha256,
      pdf: artifactBytes,
      bytes: artifactBytes.length,
      proof: independentProof,
      limitations: receipt.limitations,
      replacementCount: independentProof.replacementCount,
      localOnly: true,
      find,
      replace,
      retainedBoundaryValidated: true,
      applied: true,
      trustBoundary: Object.freeze({
        productionService: true,
        immutableSourceDigest: true,
        artifactReread: true,
        independentSemanticInspection: true,
      }),
    });
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED') {
      await aggregateTextEditFailure(ctx, artifact, error);
      throw error;
    }
    await aggregateTextEditFailure(ctx, artifact, error);
    throw error;
  }
}
