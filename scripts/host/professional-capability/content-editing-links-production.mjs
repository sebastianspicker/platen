import { result, fail, sha256, requireBytes } from './support.mjs';
import { HostError } from '../host-error.mjs';
import {
  INCREMENTAL_GOTO_LINK_PROFILE,
  validateIncrementalGoToLinkResult,
} from '../../../src/core/pdf-incremental-goto-link-contract.js';
import { normalizeIncrementalGoToLink } from '../pdf-incremental-goto-link-contract.mjs';
import {
  writeIncrementalPdfGoToLink,
  inspectIncrementalPdfGoToLink,
} from '../pdf-incremental-goto-link-writer.mjs';

const FAMILY = 'content-editing';
const SHA256 = /^[0-9a-f]{64}$/u;

function abortIfCancelled(signal) {
  if (signal?.aborted) {
    throw new HostError('JOB_CANCELLED', 'The incremental GoTo-link operation was cancelled.', 499, {
      cause: signal.reason,
    });
  }
}

export function editLinksRequest(ctx = {}) {
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf', {
    max: 128 * 1024 * 1024,
  });
  const sourceSha256 = sha256(source);
  if (!SHA256.test(ctx.sourceSha256 ?? '')) {
    fail('SOURCE_VERSION_MISMATCH', 'The supplied GoTo source digest is missing or not lowercase SHA-256.');
  }
  if (ctx.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The supplied GoTo source digest does not match the supplied source bytes.');
  }
  const sourcePage = Number.isSafeInteger(ctx.fromPage) ? ctx.fromPage : 1;
  const targetPage = Number.isSafeInteger(ctx.toPage) ? ctx.toPage : sourcePage;
  const rect = ctx.rect && typeof ctx.rect === 'object'
    ? {
      left: Number(ctx.rect.left ?? 72),
      bottom: Number(ctx.rect.bottom ?? 700),
      right: Number(ctx.rect.right ?? 200),
      top: Number(ctx.rect.top ?? 760),
    }
    : { left: 72, bottom: 700, right: 200, top: 760 };
  try {
    return {
      source,
      sourceSha256,
      request: normalizeIncrementalGoToLink({
        profile: INCREMENTAL_GOTO_LINK_PROFILE,
        sourcePage,
        targetPage,
        rect,
      }),
    };
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_GOTO_LINK') {
      fail('INVALID_INCREMENTAL_GOTO_LINK', error.message, 400);
    }
    throw error;
  }
}

export function editLinksProductionInput(ctx = {}) {
  const boundary = editLinksRequest(ctx);
  if (typeof ctx.documentId !== 'string' || ctx.documentId.length === 0) {
    fail('INCREMENTAL_GOTO_LINK_DOCUMENT_REQUIRED', 'Incremental GoTo-link production mode requires an explicit document identity.', 400);
  }
  const service = ctx.incrementalGoToLink;
  if (!service || typeof service.update !== 'function') {
    fail('INCREMENTAL_GOTO_LINK_SERVICE_UNAVAILABLE', 'The production incremental GoTo-link service is unavailable.', 503);
  }
  const readArtifact = typeof ctx.readArtifact === 'function'
    ? ctx.readArtifact
    : typeof service.readArtifact === 'function'
      ? service.readArtifact.bind(service)
      : null;
  if (typeof readArtifact !== 'function') {
    fail('INCREMENTAL_GOTO_LINK_ARTIFACT_READBACK_REQUIRED', 'Incremental GoTo-link production requires a retained artifact reread authority.', 503);
  }
  return { ...boundary, service, readArtifact };
}

export async function aggregateIncrementalGoToLinkFailure(context, artifact, failure) {
  if (!artifact || typeof context?.store?.deleteArtifact !== 'function') {
    throw failure;
  }
  try {
    await context.store.deleteArtifact(artifact.id);
  } catch (cleanupFailure) {
    throw new HostError('EDIT_LINKS_CLEANUP_FAILED', 'Production GoTo-link editing could not revoke its failed retained artifact.', 500, {
      cause: new AggregateError([failure, cleanupFailure], 'GoTo-link cleanup and revocation failed.'),
    });
  }
  throw failure;
}

export function localEditLinks(ctx = {}) {
  const { source, sourceSha256, request } = editLinksRequest(ctx);
  const written = writeIncrementalPdfGoToLink(source, request);
  let proof;
  try {
    proof = {
      ...inspectIncrementalPdfGoToLink(source, written.bytes, request),
      sourceSha256,
      outputSha256: sha256(written.bytes),
    };
  } catch {
    fail('LINK_OUTPUT_INVALID', 'Independent GoTo link output failed local reinspection.', 502);
  }
  if (
    proof.profile !== INCREMENTAL_GOTO_LINK_PROFILE || proof.sourceBytes !== source.length || proof.outputBytes !== written.bytes.length
    || proof.sourcePrefixPreserved !== true || proof.rootPreserved !== true || proof.revisionCount < 2
  ) {
    fail('LINK_OUTPUT_INVALID', 'Independent GoTo link validation did not match the local request result.', 502);
  }
  return result('edit.links', {
    familyId: FAMILY,
    method: 'local-incremental-goto-link',
    sourceSha256,
    outputSha256: sha256(written.bytes),
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof,
    link: request,
    request: request,
    linkApplied: true,
    annotationCount: written.proof?.annotationCount ?? 1,
    productionMode: false,
    nonPromotable: true,
    retainedBoundaryValidated: false,
    localOnly: true,
    trustBoundary: Object.freeze({
      productionService: false,
      immutableSourceDigest: true,
      artifactReread: false,
      independentSemanticInspection: true,
    }),
  });
}

export async function productionEditLinks(ctx = {}) {
  const boundary = editLinksProductionInput(ctx);
  let receipt;
  let artifact;
  let validated;
  try {
    abortIfCancelled(ctx.signal);
    receipt = await boundary.service.update(ctx.documentId, boundary.request, {
      sourceSha256: boundary.sourceSha256,
      signal: ctx.signal,
    });
    artifact = receipt?.artifact;
    abortIfCancelled(ctx.signal);
    const transportReceipt = JSON.parse(JSON.stringify(receipt));
    validated = validateIncrementalGoToLinkResult(transportReceipt, {
      documentId: ctx.documentId,
      sourceSha256: boundary.sourceSha256,
      request: boundary.request,
    });
    artifact = validated.artifact;
    const artifactBytes = requireBytes(await boundary.readArtifact(validated.artifact), 'incrementalGoToLinkArtifact');
    if (artifactBytes.length !== artifact.size || sha256(artifactBytes) !== artifact.sha256) {
      fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'The reread incremental GoTo-link artifact does not match its receipt.', 502);
    }
    abortIfCancelled(ctx.signal);
    const proof = {
      ...inspectIncrementalPdfGoToLink(boundary.source, artifactBytes, boundary.request),
      sourceSha256: boundary.sourceSha256,
      outputSha256: sha256(artifactBytes),
    };
    if (
      proof.profile !== INCREMENTAL_GOTO_LINK_PROFILE || proof.sourceBytes !== boundary.source.length
      || proof.outputBytes !== artifactBytes.length || proof.sourcePrefixPreserved !== true
      || proof.rootPreserved !== true || proof.sourcePage !== boundary.request.sourcePage
      || proof.targetPage !== boundary.request.targetPage || proof.rect.left !== boundary.request.rect.left
      || proof.rect.right !== boundary.request.rect.right || proof.rect.bottom !== boundary.request.rect.bottom
      || proof.rect.top !== boundary.request.rect.top
    ) {
      fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'The independent incremental GoTo-link reread proof did not match the request.', 502);
    }
    return result('edit.links', {
      familyId: FAMILY,
      method: 'production-incremental-goto-link-service',
      sourceSha256: boundary.sourceSha256,
      artifact,
      serviceReceipt: validated,
      outputSha256: artifact.sha256,
      pdf: artifactBytes,
      bytes: artifactBytes.length,
      proof: Object.freeze(proof),
      link: validated.link,
      linkApplied: true,
      limitations: validated.limitations,
      evidence: validated.evidence,
      retainedBoundaryValidated: true,
      productionMode: true,
      localOnly: true,
      trustBoundary: Object.freeze({
        productionService: true,
        immutableSourceDigest: true,
        artifactReread: true,
        independentSemanticInspection: true,
      }),
    });
  } catch (error) {
    await aggregateIncrementalGoToLinkFailure(ctx, artifact, error);
  }
}
