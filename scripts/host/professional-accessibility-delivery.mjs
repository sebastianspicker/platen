import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import { inspectPdfAccessibilityTableSemanticsSource } from './pdf-accessibility-table-semantics-writer.mjs';
import { inspectPdfAccessibilityLinksBookmarksSource } from './pdf-accessibility-links-bookmarks-writer.mjs';

const SOURCE_BOUND_ACCESSIBILITY = Object.freeze({
  'accessibility.form-semantics': Object.freeze({
    requestKey: 'formRequest', serviceKey: 'accessibilityFormSemantics', method: 'repair',
  }),
  'accessibility.table-semantics': Object.freeze({
    requestKey: 'tableRequest', serviceKey: 'accessibilityTableSemantics', method: 'repair',
  }),
  'accessibility.links-bookmarks': Object.freeze({
    requestKey: 'linksRequest', serviceKey: 'accessibilityLinksBookmarks', method: 'update',
  }),
});

const LOCATOR_INVENTORIES = Object.freeze({
  'accessibility.table-semantics': inspectPdfAccessibilityTableSemanticsSource,
  'accessibility.links-bookmarks': inspectPdfAccessibilityLinksBookmarksSource,
});

function abort(signal) {
  if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'Professional accessibility delivery was cancelled.', 499);
}

function exactSignalOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const keys = options.signal === undefined ? [] : ['signal'];
  return Object.keys(options).length === keys.length && keys.every((key) => Object.hasOwn(options, key))
    && (options.signal === undefined || options.signal instanceof AbortSignal);
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

function validInventoryRequest(request) {
  return Boolean(request) && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).length === 1 && Object.hasOwn(request, 'sourceSha256')
    && /^[0-9a-f]{64}$/u.test(request.sourceSha256 ?? '');
}

function sourceBoundAccessibilityDescriptor(capabilityId) {
  if (!Object.hasOwn(SOURCE_BOUND_ACCESSIBILITY, capabilityId)) return null;
  if (capabilityId === 'accessibility.form-semantics') return SOURCE_BOUND_ACCESSIBILITY['accessibility.form-semantics'];
  if (capabilityId === 'accessibility.table-semantics') return SOURCE_BOUND_ACCESSIBILITY['accessibility.table-semantics'];
  if (capabilityId === 'accessibility.links-bookmarks') return SOURCE_BOUND_ACCESSIBILITY['accessibility.links-bookmarks'];
  return null;
}

function locatorInventory(capabilityId) {
  if (!Object.hasOwn(LOCATOR_INVENTORIES, capabilityId)) return null;
  if (capabilityId === 'accessibility.table-semantics') return inspectPdfAccessibilityTableSemanticsSource;
  if (capabilityId === 'accessibility.links-bookmarks') return inspectPdfAccessibilityLinksBookmarksSource;
  return null;
}

function sourceBoundAuthority(capabilityId, services, promoteArtifact) {
  if (capabilityId === 'accessibility.form-semantics') {
    if (!Object.hasOwn(services, 'accessibilityFormSemantics') || typeof services.accessibilityFormSemantics?.repair !== 'function') return null;
    return Object.freeze({ repair: async (...args) => {
      const receipt = await services.accessibilityFormSemantics.repair(...args);
      if (receipt?.artifact?.id) promoteArtifact(receipt.artifact);
      return receipt;
    } });
  }
  if (capabilityId === 'accessibility.table-semantics') {
    if (!Object.hasOwn(services, 'accessibilityTableSemantics') || typeof services.accessibilityTableSemantics?.repair !== 'function') return null;
    return Object.freeze({ repair: async (...args) => {
      const receipt = await services.accessibilityTableSemantics.repair(...args);
      if (receipt?.artifact?.id) promoteArtifact(receipt.artifact);
      return receipt;
    } });
  }
  if (capabilityId === 'accessibility.links-bookmarks') {
    if (!Object.hasOwn(services, 'accessibilityLinksBookmarks') || typeof services.accessibilityLinksBookmarks?.update !== 'function') return null;
    return Object.freeze({ update: async (...args) => {
      const receipt = await services.accessibilityLinksBookmarks.update(...args);
      if (receipt?.artifact?.id) promoteArtifact(receipt.artifact);
      return receipt;
    } });
  }
  return null;
}

export function createProfessionalAccessibilityDelivery({ store, services, deliver, list }) {
  if (!store || !services || typeof deliver !== 'function' || typeof list !== 'function') {
    throw new TypeError('Professional accessibility delivery requires the document store, services, delivery entrypoint, and handler inventory.');
  }
  async function deliverSourceBound(capabilityId, documentId, request, options = {}) {
    const descriptor = sourceBoundAccessibilityDescriptor(capabilityId);
    if (!descriptor) throw new HostError('PROFESSIONAL_ACCESSIBILITY_CAPABILITY_UNSUPPORTED', 'The source-bound accessibility capability is unsupported.', 404);
    if (typeof documentId !== 'string' || documentId.length < 1 || !request || typeof request !== 'object'
      || Array.isArray(request) || !exactSignalOptions(options)) {
      throw new HostError('PROFESSIONAL_ACCESSIBILITY_OPTIONS_INVALID', 'Source-bound accessibility delivery requires a document, exact request, and optional AbortSignal.', 400);
    }
    const { signal } = options;
    abort(signal);
    await store.verifySource(documentId);
    const source = store.getDocument(documentId);
    let promotedArtifact = null;
    const authority = sourceBoundAuthority(capabilityId, services, (artifact) => { promotedArtifact = artifact; });
    if (!authority) {
      throw new HostError('PROFESSIONAL_ACCESSIBILITY_UNAVAILABLE', 'The source-bound accessibility service is unavailable.', 503);
    }
    const sourcePdf = await readFile(store.getSourcePath(documentId));
    try {
      const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
      if (sourcePdf.length !== source.size || sourceSha256 !== source.sha256) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', 'The authoritative professional accessibility source changed during resolution.', 500);
      }
      await store.verifySource(documentId);
      if (!sameSourceRecord(source, store.getDocument(documentId))) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', 'The authoritative professional accessibility source record changed during resolution.', 500);
      }
      abort(signal);
      const readArtifact = async (artifact) => {
        if (!sameArtifact(artifact, promotedArtifact)) {
          throw new HostError('PROFESSIONAL_ACCESSIBILITY_RECEIPT_INVALID', 'The accessibility receipt requested an unbound artifact reread.', 502);
        }
        const retained = store.getArtifact(artifact.id);
        if (!sameArtifact(retained, artifact) || typeof retained.filePath !== 'string') {
          throw new HostError('PROFESSIONAL_ACCESSIBILITY_RECEIPT_INVALID', 'The retained accessibility artifact does not match the service receipt.', 502);
        }
        return readFile(retained.filePath);
      };
      const outcome = await deliver(capabilityId, {
        documentId,
        sourcePdf,
        sourceSha256,
        [descriptor.requestKey]: request,
        [descriptor.serviceKey]: authority,
        readArtifact,
        signal,
      });
      await store.verifySource(documentId);
      if (!sameSourceRecord(source, store.getDocument(documentId))) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', 'The authoritative professional accessibility source record changed during delivery.', 500);
      }
      abort(signal);
      if (!sameArtifact(outcome?.artifact, promotedArtifact)
        || outcome?.serviceReceipt?.artifact?.id !== promotedArtifact?.id
        || outcome?.professionalProof !== true) {
        throw new HostError('PROFESSIONAL_ACCESSIBILITY_RECEIPT_INVALID', 'Professional accessibility delivery did not retain the validated production receipt.', 502);
      }
      return outcome;
    } catch (error) {
      if (promotedArtifact?.id) {
        try {
          await store.deleteArtifact(promotedArtifact.id);
        } catch (cleanupError) {
          throw new HostError('PROFESSIONAL_ACCESSIBILITY_CLEANUP_FAILED', 'Professional accessibility delivery could not revoke its failed artifact.', 500, {
            cause: new AggregateError([error, cleanupError]),
          });
        }
      }
      throw error;
    } finally {
      sourcePdf.fill(0);
    }
  }
  async function inventorySourceBound(capabilityId, documentId, request, options = {}) {
    const inspect = locatorInventory(capabilityId);
    if (!inspect) throw new HostError('PROFESSIONAL_ACCESSIBILITY_CAPABILITY_UNSUPPORTED', 'The accessibility locator inventory capability is unsupported.', 404);
    if (typeof documentId !== 'string' || documentId.length < 1 || !validInventoryRequest(request) || !exactSignalOptions(options)) {
      throw new HostError('PROFESSIONAL_ACCESSIBILITY_OPTIONS_INVALID', 'Accessibility locator inventory requires an exact source digest and optional AbortSignal.', 400);
    }
    const { signal } = options;
    abort(signal);
    await store.verifySource(documentId);
    const source = store.getDocument(documentId);
    if (request.sourceSha256 !== source.sha256) throw new HostError('SOURCE_VERSION_MISMATCH', 'The accessibility locator inventory digest does not match the current source.', 409);
    const sourcePdf = await readFile(store.getSourcePath(documentId));
    try {
      const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
      if (sourcePdf.length !== source.size || sourceSha256 !== source.sha256) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', 'The authoritative accessibility inventory source changed during resolution.', 500);
      }
      const inventory = inspect(sourcePdf, sourceSha256);
      await store.verifySource(documentId);
      if (!sameSourceRecord(source, store.getDocument(documentId))) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', 'The authoritative accessibility inventory source record changed during inspection.', 500);
      }
      abort(signal);
      return Object.freeze({ kind: 'professional-accessibility-locator-inventory', schemaVersion: 1, capabilityId, sourceSha256, inventory });
    } finally {
      sourcePdf.fill(0);
    }
  }
  return Object.freeze({ deliver, deliverSourceBound, inventorySourceBound, list });
}

export { SOURCE_BOUND_ACCESSIBILITY, LOCATOR_INVENTORIES };
