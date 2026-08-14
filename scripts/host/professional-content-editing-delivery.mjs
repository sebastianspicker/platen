import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HostError } from './host-error.mjs';

const SOURCE_BOUND_CONTENT_EDITING = Object.freeze({
  'edit.links': Object.freeze({
    authority: 'incrementalGoToLink',
    method: 'update',
    serviceUnavailable: 'INCREMENTAL_GOTO_LINK_SERVICE_UNAVAILABLE',
    rereadInvalid: 'EDIT_LINKS_ARTIFACT_INVALID',
    sourceDrift: 'SOURCE_INTEGRITY_FAILED',
  }),
  'edit.text': Object.freeze({
    authority: 'textEdit',
    method: 'edit',
    serviceUnavailable: 'TEXT_EDIT_SERVICE_UNAVAILABLE',
    rereadInvalid: 'TEXT_EDIT_ARTIFACT_READBACK_REQUIRED',
    sourceDrift: 'SOURCE_INTEGRITY_FAILED',
  }),
  'edit.find-replace': Object.freeze({
    authority: 'textEdit',
    method: 'findReplace',
    serviceUnavailable: 'TEXT_EDIT_SERVICE_UNAVAILABLE',
    rereadInvalid: 'TEXT_EDIT_ARTIFACT_READBACK_REQUIRED',
    sourceDrift: 'SOURCE_INTEGRITY_FAILED',
  }),
  'edit.headers-footers': Object.freeze({
    authority: 'pageHeaderFooter',
    method: 'create',
    serviceUnavailable: 'PAGE_HEADER_FOOTER_UNAVAILABLE',
    rereadInvalid: 'PAGE_HEADER_FOOTER_RETAINED_INVALID',
    sourceDrift: 'SOURCE_INTEGRITY_FAILED',
  }),
  'document.metadata-edit': Object.freeze({
    authority: 'incrementalMetadata',
    method: 'update',
    serviceUnavailable: 'METADATA_SERVICE_UNAVAILABLE',
    rereadInvalid: 'METADATA_ARTIFACT_READBACK_REQUIRED',
    sourceDrift: 'SOURCE_INTEGRITY_FAILED',
  }),
  'document.actions-javascript': Object.freeze({
    authority: 'javascriptRemoval',
    method: 'remove',
    serviceUnavailable: 'DOCUMENT_ACTIONS_JAVASCRIPT_UNAVAILABLE',
    rereadInvalid: 'DOCUMENT_ACTIONS_JAVASCRIPT_RETAINED_INVALID',
    sourceDrift: 'SOURCE_INTEGRITY_FAILED',
  }),
});

function abort(signal) {
  if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'Professional content-editing delivery was cancelled.', 499);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameArtifact(left, right) {
  return Boolean(left) && Boolean(right) && left.id === right.id && left.documentId === right.documentId
    && left.mediaType === right.mediaType && left.size === right.size && left.sha256 === right.sha256;
}

function sameSourceRecord(left, right) {
  return Boolean(left) && Boolean(right) && left.id === right.id && left.displayName === right.displayName
    && left.mediaType === right.mediaType && left.size === right.size && left.sha256 === right.sha256
    && left.origin === right.origin && left.createdAt === right.createdAt
    && JSON.stringify(left.operation) === JSON.stringify(right.operation);
}

async function revokeAfterFailure(store, artifact, error) {
  try {
    store.getArtifact(artifact.id);
  } catch (lookupError) {
    if (lookupError?.code === 'ARTIFACT_NOT_FOUND') throw error;
    throw new HostError('PROFESSIONAL_CONTENT_EDITING_CLEANUP_FAILED', 'Professional content-editing delivery could not verify revocation of its failed promoted artifact.', 500, {
      cause: new AggregateError([error, lookupError], 'Content-editing revocation lookup failed.'),
    });
  }
  try {
    await store.deleteArtifact(artifact.id);
  } catch (cleanupError) {
    throw new HostError('PROFESSIONAL_CONTENT_EDITING_CLEANUP_FAILED', 'Professional content-editing delivery could not revoke its failed promoted artifact.', 500, {
      cause: new AggregateError([error, cleanupError], 'Content-editing cleanup and revocation failed.'),
    });
  }
  throw error;
}

function sourceBoundDescriptor(capabilityId) {
  return SOURCE_BOUND_CONTENT_EDITING[capabilityId] ?? null;
}

export function createProfessionalContentEditingDelivery({ store, services, deliver, list }) {
  if (!store || !services || typeof deliver !== 'function' || typeof list !== 'function') {
    throw new TypeError('Professional content-editing delivery requires the document store, services, delivery entrypoint, and handler inventory.');
  }
  const runDelivery = deliver;
  async function deliverSourceBound(capabilityId, documentId, request = {}, options = {}) {
    const descriptor = sourceBoundDescriptor(capabilityId);
    if (!descriptor) throw new HostError('PROFESSIONAL_CONTENT_EDITING_CAPABILITY_UNSUPPORTED', 'The source-bound content-editing capability is unsupported.', 404);
    if (typeof documentId !== 'string' || documentId.length < 1) {
      throw new HostError('SOURCE_DOCUMENT_UNAVAILABLE', 'Content-editing source-bound delivery requires an explicit source document id.', 503);
    }
    if (!isObject(request)) throw new HostError('PROFESSIONAL_CONTENT_EDITING_OPTIONS_INVALID', 'Content-editing source-bound delivery requires a valid request object.', 400);
    const { signal } = options;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new HostError('PROFESSIONAL_CONTENT_EDITING_OPTIONS_INVALID', 'Content-editing source-bound delivery supports only an optional AbortSignal option.', 400);
    }
    return runSourceBound(capabilityId, { ...request, documentId, signal }, descriptor);
  }
  async function deliverSourceBoundContext(capabilityId, context = {}) {
    const descriptor = sourceBoundDescriptor(capabilityId);
    if (!descriptor) return runDelivery(capabilityId, context);
    if (!isObject(context)) {
      throw new HostError('PROFESSIONAL_CONTENT_EDITING_OPTIONS_INVALID', 'Content-editing source-bound delivery requires a valid context object.', 400);
    }
    return runSourceBound(capabilityId, context, descriptor);
  }
  async function runSourceBound(capabilityId, context, descriptor) {
    const { signal, documentId } = context;
    abort(signal);
    if (typeof documentId !== 'string' || documentId.length < 1) {
      throw new HostError('SOURCE_DOCUMENT_UNAVAILABLE', 'Content-editing source-bound delivery requires an explicit source document id.', 503);
    }
    await store.verifySource(documentId);
    const source = store.getDocument(documentId);
    const sourcePdf = await readFile(store.getSourcePath(documentId));
    let promotedArtifact = null;
    try {
      const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
      if (sourcePdf.length !== source.size || sourceSha256 !== source.sha256) {
        throw new HostError(descriptor.sourceDrift, 'The authoritative professional content-editing source changed during resolution.', 500);
      }
      const service = services[descriptor.authority];
      if (!service || typeof service[descriptor.method] !== 'function') {
        throw new HostError(descriptor.serviceUnavailable, `The ${descriptor.authority} service is unavailable for content-editing delivery.`, 503);
      }
      abort(signal);
      const readArtifact = async (artifact) => {
        if (!isObject(artifact)) {
          throw new HostError(descriptor.rereadInvalid, 'The content-editing reread artifact record is not structured for retained output.', 502);
        }
        if (promotedArtifact === null) {
          promotedArtifact = artifact;
        } else if (!sameArtifact(artifact, promotedArtifact)) {
          throw new HostError('PROFESSIONAL_CONTENT_EDITING_RECEIPT_INVALID', 'The content-editing reread artifact does not match the promoted output.', 502);
        }
        const retained = store.getArtifact(artifact.id);
        if (!sameArtifact(retained, artifact) || typeof retained.filePath !== 'string') {
          throw new HostError('PROFESSIONAL_CONTENT_EDITING_RETAINED_INVALID', 'The retained content-editing artifact does not match the validated receipt.', 502);
        }
        const artifactBytes = await readFile(retained.filePath);
        if (artifactBytes.length !== artifact.size || createHash('sha256').update(artifactBytes).digest('hex') !== artifact.sha256) {
          throw new HostError('PROFESSIONAL_CONTENT_EDITING_OUTPUT_INVALID', 'The retained content-editing artifact bytes do not match its validated digest.', 409);
        }
        return artifactBytes;
      };
      const authority = Object.freeze({
        [descriptor.method]: async (...args) => {
          const receipt = await service[descriptor.method](...args);
          if (receipt?.artifact?.id) promotedArtifact = receipt.artifact;
          return receipt;
        },
      });
      const outcome = await runDelivery(capabilityId, {
        ...context,
        documentId,
        sourcePdf,
        sourceSha256,
        [descriptor.authority]: authority,
        readArtifact,
        store,
        signal,
      });
      if (!promotedArtifact && outcome?.artifact) {
        promotedArtifact = outcome.artifact;
      }
      await store.verifySource(documentId);
      const retainedSource = store.getDocument(documentId);
      if (!sameSourceRecord(source, retainedSource)) {
        throw new HostError(descriptor.sourceDrift, 'The authoritative professional content-editing source changed during delivery.', 500);
      }
      abort(signal);
      if (!outcome?.artifact || !outcome?.serviceReceipt?.artifact) {
        throw new HostError('PROFESSIONAL_CONTENT_EDITING_RECEIPT_INVALID', 'Professional content-editing delivery did not return a retained artifact.', 502);
      }
      if (!sameArtifact(outcome.artifact, promotedArtifact)
        || !sameArtifact(outcome.serviceReceipt.artifact, outcome.artifact)
      ) {
        throw new HostError('PROFESSIONAL_CONTENT_EDITING_RECEIPT_INVALID', 'Professional content-editing delivery did not retain a valid production receipt.', 502);
      }
      return outcome;
    } catch (error) {
      if (promotedArtifact) {
        return revokeAfterFailure(store, promotedArtifact, error);
      }
      throw error;
    } finally {
      sourcePdf.fill(0);
    }
  }
  async function deliverCapability(capabilityId, context = {}) {
    const descriptor = sourceBoundDescriptor(capabilityId);
    if (!descriptor) return runDelivery(capabilityId, context);
    return deliverSourceBoundContext(capabilityId, context);
  }
  return Object.freeze({ deliver: deliverCapability, deliverSourceBoundContext, deliverSourceBound, list });
}
