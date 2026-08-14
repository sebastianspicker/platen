import { result, fail, sha256 } from './support.mjs';
import { HostError } from '../host-error.mjs';
import { inspectIncrementalPdfMetadata } from '../pdf-incremental-metadata-writer.mjs';
import {
  INCREMENTAL_METADATA_PROFILE,
  STANDARD_METADATA_FIELDS,
  validateIncrementalMetadataResult,
  validIncrementalMetadata,
} from '../../../src/core/pdf-incremental-metadata-contract.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const FAMILY = 'content-editing';

export function metadataRequest(ctx, { required }) {
  const sourceMetadata = ctx.metadata;
  if (sourceMetadata !== undefined) {
    if (!sourceMetadata || typeof sourceMetadata !== 'object' || Array.isArray(sourceMetadata)) {
      fail('METADATA_REQUEST_INVALID', 'document.metadata-edit requires an exact metadata request.', 400);
    }
    if (
      required
      && (!STANDARD_METADATA_FIELDS.every((field) => Object.hasOwn(sourceMetadata, field))
        || Object.keys(sourceMetadata).length !== STANDARD_METADATA_FIELDS.length)
    ) {
      fail('METADATA_REQUEST_INVALID', 'document.metadata-edit requires an exact metadata request.', 400);
    }
    if (STANDARD_METADATA_FIELDS.some((field) => sourceMetadata[field] !== null
      && typeof sourceMetadata[field] !== 'string')) {
      fail('METADATA_REQUEST_INVALID', 'document.metadata-edit requires an exact metadata request.', 400);
    }
    return Object.freeze({
      title: sourceMetadata.title,
      author: sourceMetadata.author,
      subject: sourceMetadata.subject,
      keywords: sourceMetadata.keywords,
    });
  }
  const legacy = {
    title: ctx.title,
    author: ctx.author,
    subject: ctx.subject,
    keywords: ctx.keywords,
  };
  const hasAny = STANDARD_METADATA_FIELDS.some((field) => Object.hasOwn(ctx, field));
  if (!hasAny && !required) {
    return Object.freeze({
      title: 'Edited Title',
      author: 'Local author',
      subject: 'Professional metadata',
      keywords: null,
    });
  }
  if (!required || STANDARD_METADATA_FIELDS.some((field) => !Object.hasOwn(ctx, field))) {
    fail('METADATA_REQUEST_REQUIRED', 'document.metadata-edit requires title, author, subject, and keywords.', 400);
  }
  return Object.freeze(legacy);
}

export function requestRequiresProductionMetadata(ctx) {
  return typeof ctx.incrementalMetadata?.update === 'function';
}

export async function executeRetainedMetadataEdit(context, source, sourceSha256) {
  if (context.signal?.aborted) {
    fail('JOB_CANCELLED', 'The metadata-edit operation was cancelled.', 499, context.signal.reason);
  }
  const metadata = metadataRequest(context, { required: true });
  if (!validIncrementalMetadata(metadata)) {
    fail('METADATA_REQUEST_INVALID', 'The metadata request is invalid for incremental metadata editing.', 400);
  }
  const service = context.incrementalMetadata;
  if (typeof service?.update !== 'function') {
    fail('METADATA_SERVICE_UNAVAILABLE', 'Production incremental metadata editing is unavailable.', 503);
  }
  const readArtifact = typeof context.readArtifact === 'function'
    ? context.readArtifact
    : typeof service.readArtifact === 'function'
      ? service.readArtifact.bind(service)
      : null;
  if (typeof readArtifact !== 'function') {
    fail('METADATA_ARTIFACT_READBACK_REQUIRED', 'Metadata editing requires an explicit retained artifact reread authority.', 503);
  }
  let receipt;
  try {
    receipt = await service.update(context.documentId, metadata, {
      sourceSha256,
      signal: context.signal,
    });
  } catch (error) {
    if (error?.code) throw error;
    fail('METADATA_SERVICE_FAILED', 'Production incremental metadata editing failed.', 502, error);
  }

  let validated;
  try {
    validated = validateIncrementalMetadataResult(receipt, {
      documentId: context.documentId,
      sourceSha256,
    });
  } catch (error) {
    if (error?.code === 'INVALID_LOCAL_HOST') {
      await aggregateMetadataFailure(context, receipt?.artifact, new HostError('METADATA_RECEIPT_INVALID', 'The production incremental metadata receipt was invalid.', 502, { cause: error }));
    }
    throw error;
  }
  let artifactBytes;
  try {
    artifactBytes = await readArtifact(validated.artifact);
    if (!Buffer.isBuffer(artifactBytes) && !(artifactBytes instanceof Uint8Array)) {
      fail('METADATA_ARTIFACT_READBACK_INVALID', 'The incremental metadata reread authority did not return PDF bytes.', 502);
    }
    artifactBytes = Buffer.from(artifactBytes);
    if (artifactBytes.length !== validated.artifact.size || sha256(artifactBytes) !== validated.artifact.sha256) {
      fail('METADATA_OUTPUT_INVALID', 'The reread incremental metadata artifact does not match its receipt.', 502);
    }
    const proof = inspectIncrementalPdfMetadata(source, artifactBytes, metadata);
    if (
      proof.profile !== INCREMENTAL_METADATA_PROFILE || proof.sourceBytes !== source.length
      || proof.outputBytes !== artifactBytes.length || proof.metadataFieldCount !== STANDARD_METADATA_FIELDS.length
      || proof.sourcePrefixPreserved !== true || proof.priorObjectOffsetsPreserved !== true
      || proof.rootPreserved !== true
    ) {
      fail('METADATA_OUTPUT_INVALID', 'The independent incremental metadata proof was not properly bounded.', 502);
    }
    if (!artifactBytes.subarray(0, source.length).equals(source)) {
      fail('METADATA_OUTPUT_INVALID', 'The retained incremental metadata output did not preserve the source prefix.', 502);
    }
    return result('document.metadata-edit', {
      familyId: FAMILY,
      method: 'production-incremental-metadata-service',
      sourceSha256,
      metadata,
      artifact: validated.artifact,
      limitations: validated.limitations,
      outputSha256: validated.artifact.sha256,
      pdf: artifactBytes,
      bytes: artifactBytes.length,
      proof,
      metadataProfile: validated.metadata.profile,
      applied: true,
      retainedBoundaryValidated: true,
      localOnly: true,
      trustBoundary: Object.freeze({
        productionService: true,
        immutableSourceDigest: true,
        artifactReread: true,
        independentSemanticInspection: true,
      }),
      serviceReceipt: validated,
    });
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED') throw error;
    await aggregateMetadataFailure(context, validated?.artifact, error);
    throw error;
  }
}

async function aggregateMetadataFailure(context, artifact, failure) {
  if (failure?.code === 'JOB_CANCELLED' || !artifact || typeof context.store?.deleteArtifact !== 'function') {
    throw failure;
  }
  try {
    await context.store.deleteArtifact(artifact.id);
  } catch (cleanupFailure) {
    throw new HostError('DOCUMENT_METADATA_CLEANUP_FAILED', 'Production metadata edit could not revoke the failed retained artifact.', 500, {
      cause: new AggregateError([failure, cleanupFailure], 'Metadata edit cleanup and revocation failed.'),
    });
  }
  throw failure;
}
