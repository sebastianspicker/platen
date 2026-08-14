import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HostError } from './host-error.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;

const SOURCE_BOUND_PAGE_ORGANIZATION = Object.freeze({
  'pages.page-boxes': Object.freeze({
    serviceKey: 'service',
    pdfkitMutationsKey: 'pdfkitMutations',
    sourceDrift: 'SOURCE_INTEGRITY_FAILED',
    serviceUnavailable: 'PAGES_SERVICE_UNAVAILABLE',
    receiptInvalid: 'PROFESSIONAL_PAGE_ORGANIZATION_RECEIPT_INVALID',
    cleanupFailed: 'PROFESSIONAL_PAGE_ORGANIZATION_CLEANUP_FAILED',
    optionsInvalid: 'PROFESSIONAL_PAGE_ORGANIZATION_OPTIONS_INVALID',
    capabilityUnsupported: 'PROFESSIONAL_PAGE_ORGANIZATION_CAPABILITY_UNSUPPORTED',
  }),
  'pages.insert-blank': Object.freeze({
    serviceKey: 'service',
    blankFactoryKey: 'blankPageFactory',
    sourceDrift: 'SOURCE_INTEGRITY_FAILED',
    serviceUnavailable: 'PAGES_SERVICE_UNAVAILABLE',
    receiptInvalid: 'PROFESSIONAL_PAGE_ORGANIZATION_RECEIPT_INVALID',
    cleanupFailed: 'PROFESSIONAL_PAGE_ORGANIZATION_CLEANUP_FAILED',
    optionsInvalid: 'PROFESSIONAL_PAGE_ORGANIZATION_OPTIONS_INVALID',
    capabilityUnsupported: 'PROFESSIONAL_PAGE_ORGANIZATION_CAPABILITY_UNSUPPORTED',
  }),
});

function abort(signal) {
  if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'Professional page-organization delivery was cancelled.', 499);
}

function exactSignalOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype || Object.getOwnPropertySymbols(options).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const fields = Reflect.ownKeys(descriptors);
  if (fields.length === 0) return true;
  const signal = descriptors.signal;
  return fields.length === 1 && fields[0] === 'signal' && signal?.enumerable === true
    && Object.hasOwn(signal, 'value') && signal.value instanceof AbortSignal;
}

function exactPlainObject(value, keys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = Reflect.ownKeys(descriptors);
  if (fields.some((field) => typeof field !== 'string') || fields.length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key))) return false;
  if (fields.some((field) => {
    const descriptor = descriptors[field];
    return !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true;
  })) return false;
  return true;
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

function validRequest(capabilityId, value) {
  const keys = capabilityId === 'pages.insert-blank'
    ? ['sourceSha256', 'afterPage']
    : ['sourceSha256', 'page', 'boxType', 'box'];
  if (!exactPlainObject(value, keys)) return false;
  if (!SHA256.test(value.sourceSha256 ?? '')) return false;
  if (capabilityId === 'pages.insert-blank') return Number.isSafeInteger(value.afterPage) && value.afterPage >= 1;
  const { page, boxType, box } = value;
  if (!Number.isSafeInteger(page) || page < 1) return false;
  if (boxType !== 'crop' && boxType !== 'bleed') return false;
  if (!exactPlainObject(box, ['left', 'bottom', 'right', 'top'])
    || !['left', 'bottom', 'right', 'top'].every((key) => Number.isFinite(box[key]))
    || !Number.isFinite(box.left) || !Number.isFinite(box.bottom) || !Number.isFinite(box.right) || !Number.isFinite(box.top)
    || box.right <= box.left || box.top <= box.bottom) {
    return false;
  }
  return true;
}

async function revokeAfterFailure(store, artifact, error, code, message) {
  try {
    store.getArtifact(artifact.id);
  } catch (lookupError) {
    if (lookupError?.code === 'ARTIFACT_NOT_FOUND') throw error;
    throw new HostError(code, message, 500, { cause: new AggregateError([error, lookupError], 'Page-organization revocation lookup failed.') });
  }
  try {
    await store.deleteArtifact(artifact.id);
  } catch (cleanupError) {
    throw new HostError(code, message, 500, { cause: new AggregateError([error, cleanupError], 'Page-organization cleanup and revocation failed.') });
  }
  throw error;
}

function createPageOrganizationContext(coreContext, hiddenContext) {
  const requestContext = Object.freeze({
    page: coreContext.page,
    afterPage: coreContext.afterPage,
    boxType: coreContext.boxType,
    ...(coreContext.box ? { box: Object.freeze({
      left: coreContext.box.left,
      bottom: coreContext.box.bottom,
      right: coreContext.box.right,
      top: coreContext.box.top,
    }) } : {}),
  });
  return new Proxy(requestContext, {
    get(target, property, receiver) {
      if (typeof property === 'string' && Object.hasOwn(target, property)) return Reflect.get(target, property, receiver);
      if (property === 'documentId') return hiddenContext.documentId;
      if (property === 'sourceSha256') return hiddenContext.sourceSha256;
      if (property === 'signal') return hiddenContext.signal;
      if (property === 'service') return hiddenContext.service;
      if (property === 'pdfkitMutations') return hiddenContext.pdfkitMutations;
      if (property === 'blankPageFactory') return hiddenContext.blankPageFactory;
      if (property === 'store') return hiddenContext.store;
      return undefined;
    },
  });
}

async function verifyRetainedArtifact(store, record, expectedOwnerId, expectedDigest, descriptor) {
  if (!sameArtifact(record, descriptor)) {
    throw new HostError('PROFESSIONAL_PAGE_ORGANIZATION_OUTPUT_INVALID', 'The page-organization output receipt is not a valid retained artifact.', 502);
  }
  if (!SHA256.test(record.sha256 ?? '') || !SHA256.test(expectedDigest ?? '')) {
    throw new HostError('PROFESSIONAL_PAGE_ORGANIZATION_OUTPUT_INVALID', 'The page-organization output digest is malformed.', 502);
  }
  const artifact = store.getArtifact(record.id);
  if (!sameArtifact(artifact, record) || artifact.documentId !== expectedOwnerId || typeof artifact.filePath !== 'string') {
    throw new HostError('PROFESSIONAL_PAGE_ORGANIZATION_OUTPUT_INVALID', 'The page-organization output receipt does not match a retained artifact.', 502);
  }
  const artifactBytes = await readFile(artifact.filePath);
  try {
    if (artifactBytes.length !== artifact.size || createHash('sha256').update(artifactBytes).digest('hex') !== expectedDigest
      || artifact.sha256 !== expectedDigest) {
      throw new HostError('PROFESSIONAL_PAGE_ORGANIZATION_OUTPUT_INVALID', 'The page-organization retained artifact bytes did not match its validated digest.', 409);
    }
  } finally {
    artifactBytes.fill(0);
  }
}

function sourceBoundDescriptor(capabilityId) {
  return SOURCE_BOUND_PAGE_ORGANIZATION[capabilityId] ?? null;
}

async function deliverSourceBound({ store, services, deliver }, capabilityId, documentId, request = {}, options = {}) {
  const descriptor = sourceBoundDescriptor(capabilityId);
  if (!descriptor) {
    throw new HostError(descriptor?.capabilityUnsupported ?? 'PROFESSIONAL_PAGE_ORGANIZATION_CAPABILITY_UNSUPPORTED', 'The source-bound page-organization capability is unsupported.', 404);
  }
  if (typeof documentId !== 'string' || documentId.length < 1 || !isObject(request) || !exactSignalOptions(options)
    || !validRequest(capabilityId, request)) {
    throw new HostError(descriptor.optionsInvalid, 'Page-organization source-bound delivery requires an exact request and optional AbortSignal.', 400);
  }
  const { signal } = options;
  const {
    sourceSha256, page, afterPage, boxType, box
  } = request;
  abort(signal);
  await store.verifySource(documentId);
  const source = store.getDocument(documentId);
  const sourcePdf = await readFile(store.getSourcePath(documentId));
  let retainedSourceBytes = null;
  let promotedArtifact = null; let outcomeArtifact = null;
  try {
    const sourceDigest = createHash('sha256').update(sourcePdf).digest('hex');
    if (sourcePdf.length !== source.size || sourceDigest !== source.sha256 || source.sha256 !== sourceSha256) {
      throw new HostError(descriptor.sourceDrift, 'The authoritative page-organization source changed during resolution.', 500);
    }
    const service = services[descriptor.serviceKey];
    const pdfkitMutations = services[descriptor.pdfkitMutationsKey];
    const blankPageFactory = services[descriptor.blankFactoryKey];
    if (!service || typeof service.inspect !== 'function'
      || (capabilityId === 'pages.page-boxes' && (!pdfkitMutations || typeof pdfkitMutations.mutate !== 'function'))
      || (capabilityId === 'pages.insert-blank' && (!service.insertDocument || typeof service.insertDocument !== 'function'
        || !blankPageFactory || typeof blankPageFactory.createBlank !== 'function'))) {
      throw new HostError(descriptor.serviceUnavailable, 'The page-organization service stack is unavailable for this environment.', 503);
    }
    const boundPdfKitMutations = Object.freeze({
      mutate: async (...args) => {
        const receipt = await pdfkitMutations.mutate(...args);
        if (receipt?.artifact?.id && promotedArtifact === null) {
          promotedArtifact = receipt.artifact;
        } else if (receipt?.artifact?.id && !sameArtifact(receipt.artifact, promotedArtifact)) {
          throw new HostError(descriptor.receiptInvalid, 'The page-organization result promoted multiple artifacts.', 502);
        }
        return receipt;
      },
    });
    const boundService = Object.freeze({
      inspect: async (...args) => service.inspect(...args),
      ...(typeof service.inspectPage === 'function' ? { inspectPage: async (...args) => service.inspectPage(...args) } : {}),
      ...(typeof service.extractText === 'function' ? { extractText: async (...args) => service.extractText(...args) } : {}),
      ...(typeof service.insertDocument === 'function' ? {
        insertDocument: async (...args) => {
          const receipt = await service.insertDocument(...args);
          if (receipt?.id && promotedArtifact === null) promotedArtifact = receipt;
          else if (receipt?.id && !sameArtifact(receipt, promotedArtifact)) {
            throw new HostError(descriptor.receiptInvalid, 'The page-organization result promoted multiple artifacts.', 502);
          }
          return receipt;
        },
      } : {}),
    });
    const boundBlankPageFactory = capabilityId === 'pages.insert-blank'
      ? Object.freeze({ createBlank: async (...args) => blankPageFactory.createBlank(...args) })
      : undefined;
    const context = createPageOrganizationContext({
      page,
      afterPage,
      boxType,
      box,
    }, {
      documentId,
      sourceSha256,
      signal,
      service: boundService,
      pdfkitMutations: boundPdfKitMutations,
      blankPageFactory: boundBlankPageFactory,
      store,
    });
    const outcome = await deliver(capabilityId, context);
    outcomeArtifact = outcome?.artifact ?? outcome?.serviceReceipt?.artifact ?? null;
    const outputSha256 = outcome?.outputSha256;
    if (!outcomeArtifact || !sameArtifact(outcomeArtifact, promotedArtifact)) {
      throw new HostError(descriptor.receiptInvalid, 'Professional page-organization delivery did not return the promoted artifact.', 502);
    }
    if (outcome?.serviceReceipt?.artifact && !sameArtifact(outcome.serviceReceipt.artifact, outcomeArtifact)) {
      throw new HostError(descriptor.receiptInvalid, 'Professional page-organization delivery did not return the same retained artifact in service receipt.', 502);
    }
    if (outcome.sourceSha256 !== source.sha256
      || outcome?.artifact?.documentId !== source.id) {
      throw new HostError(descriptor.receiptInvalid, 'The page-organization output did not confirm its source binding.', 502);
    }
    await verifyRetainedArtifact(store, outcomeArtifact, source.id, outputSha256, outcomeArtifact);
    await store.verifySource(documentId);
    const retainedSource = store.getDocument(documentId);
    retainedSourceBytes = await readFile(store.getSourcePath(documentId));
    const retainedSourceSha256 = createHash('sha256').update(retainedSourceBytes).digest('hex');
    if (retainedSourceBytes.length !== source.size || retainedSourceSha256 !== source.sha256
      || !sameSourceRecord(source, retainedSource)) {
      throw new HostError(descriptor.sourceDrift, 'The authoritative page-organization source changed during delivery.', 500);
    }
    abort(signal);
    return outcome;
  } catch (error) {
    const artifactForCleanup = promotedArtifact;
    if (artifactForCleanup) {
      return revokeAfterFailure(store, artifactForCleanup, error, descriptor.cleanupFailed,
        'Professional page-organization delivery could not revoke its failed promoted artifact.',
      );
    }
    throw error;
  } finally {
    sourcePdf.fill(0);
    retainedSourceBytes?.fill(0);
  }
}

export function createProfessionalPageOrganizationDelivery({ store, services, deliver, list }) {
  if (!store || !services || typeof deliver !== 'function' || typeof list !== 'function') {
    throw new TypeError('Professional page-organization delivery requires the document store, services, delivery entrypoint, and handler inventory.');
  }
  async function deliverSourceBoundPublic(capabilityId, documentId, request = {}, options = {}) {
    return deliverSourceBound({ store, services, deliver }, capabilityId, documentId, request, options);
  }

  async function deliverSourceBoundContext(capabilityId, context = {}) {
    const descriptor = sourceBoundDescriptor(capabilityId);
    if (!descriptor) return deliver(capabilityId, context);
    if (!isObject(context)) {
      throw new HostError(descriptor.optionsInvalid, 'Page-organization source-bound delivery requires a valid context object.', 400);
    }
    return deliverSourceBound({ store, services, deliver }, capabilityId, context.documentId, {
      sourceSha256: context.sourceSha256,
      page: context.page,
      afterPage: context.afterPage,
      boxType: context.boxType,
      box: context.box,
    }, context.signal === undefined ? {} : { signal: context.signal });
  }

  async function deliverCapability(capabilityId, context = {}) {
    const descriptor = sourceBoundDescriptor(capabilityId);
    if (!descriptor) return deliver(capabilityId, context);
    return deliverSourceBoundContext(capabilityId, context);
  }

  return Object.freeze({ deliver: deliverCapability, deliverSourceBoundContext, deliverSourceBound: deliverSourceBoundPublic, list });
}
