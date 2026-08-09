import {
  PDF_PAGE_LABELS_PROFILE,
} from '../pdf-page-labels-contract.mjs';
import {
  INCREMENTAL_PAGE_TRANSITION_PROFILE,
} from '../pdf-incremental-page-transition-contract.mjs';
import { PDFKIT_DERIVED_PROFILE } from '../pdfkit-mutation-contract.mjs';
import {
  sources, service, complete, invalid, outputInvalid, unavailable, pages,
} from './page-organization-core.mjs';
import { fail } from './support.mjs';

const STANDARD_BLANK_PAGE = Object.freeze({ widthPoints: 612, heightPoints: 792 });

function exactPlainObject(value, label, keys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(`${label} must be an exact plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = Reflect.ownKeys(descriptors);
  if (fields.some((field) => typeof field !== 'string') || fields.length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key))) {
    invalid(`${label} contains unsupported fields.`);
  }
  if (fields.some((field) => {
    const descriptor = descriptors[field];
    return !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true;
  })) {
    invalid(`${label} contains unsupported accessors or non-enumerable properties.`);
  }
  return value;
}

async function pdfKitMutation(ctx, capabilityId, mutation, operationCheck, method, payload = {}) {
  const binding = await sources(ctx);
  if (ctx.signal?.aborted) {
    const error = new Error('Page organization source-bound mutation was cancelled.', { cause: ctx.signal.reason });
    error.code = 'JOB_CANCELLED';
    error.status = 499;
    throw error;
  }
  if (!ctx.pdfkitMutations || typeof ctx.pdfkitMutations.mutate !== 'function') {
    unavailable('Page mutation requires the pinned local PDFKit mutation service.');
  }
  const serviceResult = await ctx.pdfkitMutations.mutate(binding.primary.id, mutation, {
    sourceSha256: binding.primary.sha256, profile: PDFKIT_DERIVED_PROFILE, signal: ctx.signal,
  });
  if (serviceResult?.sourceDigest !== binding.primary.sha256 || serviceResult?.evidence?.sourceDigestReverified !== true
    || serviceResult?.evidence?.nativeEffectsReopened !== true || serviceResult?.evidence?.allPagesRendered !== true) {
    outputInvalid('The PDFKit mutation receipt lacks independent source and output validation.');
  }
  if (ctx.signal?.aborted) {
    const error = new Error('Page organization source-bound mutation was cancelled.', { cause: ctx.signal.reason });
    error.code = 'JOB_CANCELLED';
    error.status = 499;
    throw error;
  }
  const inspection = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  return complete(ctx, binding, serviceResult.artifact, {
    type: 'pdfkit-mutation', inputs: [{ documentId: binding.primary.id, sha256: binding.primary.sha256, role: 'source' }],
    expectedPageCount: inspection.pageCount,
    validation: ['source-sha256', 'pdfkit-effect-reopen', 'poppler-page-count', 'poppler-render-all-pages'],
    extra: operationCheck,
  }, capabilityId, method, payload);
}

export async function pagesCrop(ctx = {}) {
  const page = ctx.page;
  const box = ctx.box;
  if (!Number.isSafeInteger(page) || page < 1 || !box || !['left', 'bottom', 'right', 'top'].every((key) => Number.isFinite(box[key]))
    || box.right <= box.left || box.top <= box.bottom) invalid('Crop requires one page and a non-empty left/bottom/right/top box.');
  const rect = { x: box.left, y: box.bottom, width: box.right - box.left, height: box.top - box.bottom };
  return pdfKitMutation(ctx, 'pages.crop', { metadata: null, pageBox: { page, box: 'crop', rect }, rotation: null, annotations: [] },
    (operation) => operation.validation?.croppedPage === page && JSON.stringify(operation.validation?.persistentCropBox) === JSON.stringify(rect),
    'source-bound-pdfkit-crop', { page, box: Object.freeze({ ...box }) });
}

export async function pagesRotate(ctx = {}) {
  const page = ctx.page;
  const rotation = ctx.rotation;
  if (!Number.isSafeInteger(page) || page < 1 || ![0, 90, 180, 270].includes(rotation)) {
    invalid('Rotate requires one page and an absolute 0, 90, 180, or 270 degree rotation.');
  }
  return pdfKitMutation(ctx, 'pages.rotate', { metadata: null, pageBox: null, rotation: { page, degrees: rotation }, annotations: [] },
    (operation) => operation.validation?.rotatedPage === page && operation.validation?.pageRotation === rotation,
    'source-bound-pdfkit-rotation', { page, rotation });
}

export async function pagesPageBoxes(ctx = {}) {
  const page = ctx.page;
  const boxType = ctx.boxType;
  const box = exactPlainObject(ctx.box, 'pages.page-boxes box request', ['left', 'bottom', 'right', 'top']);
  if (!['crop', 'bleed'].includes(boxType) || !Number.isSafeInteger(page) || page < 1 || !box
    || !['left', 'bottom', 'right', 'top'].every((key) => Number.isFinite(box[key]))
    || box.right <= box.left || box.top <= box.bottom) {
    invalid('Page boxes supports one selected crop or bleed box with a non-empty rectangle.');
  }
  const rect = { x: box.left, y: box.bottom, width: box.right - box.left, height: box.top - box.bottom };
  const checkRect = (expected, observed) => JSON.stringify(expected) === JSON.stringify(observed);
  return pdfKitMutation(ctx, 'pages.page-boxes', { metadata: null, pageBox: { page, box: boxType, rect }, rotation: null, annotations: [] },
    (operation) => (boxType === 'crop'
      ? operation.validation?.croppedPage === page
        && checkRect(operation.validation?.persistentCropBox, rect)
      : operation.validation?.bleedBoxPage === page
        && checkRect(operation.validation?.persistentBleedBox, rect)),
    `source-bound-pdfkit-${boxType}-box`, { page, boxType, box: Object.freeze({ ...box }) });
}

export async function pagesLabelsNumbering(ctx = {}) {
  const binding = await sources(ctx);
  if (!ctx.pageLabels || typeof ctx.pageLabels.create !== 'function' || !Array.isArray(ctx.ranges)) {
    unavailable('Page labels requires the bounded local page-label authoring service and canonical ranges.');
  }
  const request = { profile: PDF_PAGE_LABELS_PROFILE, sourceSha256: binding.primary.sha256, ranges: ctx.ranges };
  const serviceResult = await ctx.pageLabels.create(binding.primary.id, request, { sourceSha256: binding.primary.sha256, signal: ctx.signal });
  if (serviceResult?.sourceDigest !== binding.primary.sha256 || serviceResult?.evidence?.sourcePrefixPreserved !== true
    || serviceResult?.evidence?.outputDigestBound !== true || serviceResult?.evidence?.sourceUnchanged !== true) {
    outputInvalid('The page-label receipt lacks independent validation.');
  }
  return complete(ctx, binding, serviceResult.artifact, {
    type: 'pdf-page-labels', inputs: [{ documentId: binding.primary.id, sha256: binding.primary.sha256, role: 'source' }],
    expectedPageCount: serviceResult.pageCount,
    provenancePageCount: false,
    validation: ['source-sha256', 'page-label-proof', 'artifact-sha256'],
    extra: (operation) => operation.parameters?.profile === PDF_PAGE_LABELS_PROFILE,
  }, 'pages.labels-numbering', 'source-bound-page-label-authoring', { ranges: ctx.ranges });
}

export async function pagesTransitions(ctx = {}) {
  const binding = await sources(ctx);
  const transition = ctx.transition ?? 'Dissolve';
  const duration = ctx.duration;
  const transitionPages = pages(ctx.pages, 'pages');
  if (transition !== 'Dissolve' || !Number.isFinite(duration) || duration <= 0 || duration > 60) {
    invalid('Transitions supports the bounded Dissolve profile with a duration from 0 through 60 seconds.');
  }
  if (!ctx.incrementalPageTransition || typeof ctx.incrementalPageTransition.update !== 'function') {
    unavailable('Page transitions requires the local incremental page-transition service.');
  }
  const request = { profile: INCREMENTAL_PAGE_TRANSITION_PROFILE, pages: transitionPages, transition, duration };
  const serviceResult = await ctx.incrementalPageTransition.update(binding.primary.id, request, { sourceSha256: binding.primary.sha256, signal: ctx.signal });
  if (serviceResult?.sourceDigest !== binding.primary.sha256 || serviceResult?.evidence?.sourcePrefixPreserved !== true
    || serviceResult?.evidence?.rawReinspectionPassed !== true || serviceResult?.evidence?.onlySelectedPagesChanged !== true) {
    outputInvalid('The page-transition receipt lacks independent append-only validation.');
  }
  const inspection = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  return complete(ctx, binding, serviceResult.artifact, {
    type: 'pdf-incremental-page-transition', inputs: [{ documentId: binding.primary.id, sha256: binding.primary.sha256, role: 'source' }],
    expectedPageCount: inspection.pageCount,
    provenancePageCount: false,
    validation: ['source-sha256', 'raw-transition-reinspection', 'page-topology-preserved'],
    extra: (operation) => operation.parameters?.profile === INCREMENTAL_PAGE_TRANSITION_PROFILE
      && JSON.stringify(operation.parameters?.pages) === JSON.stringify(transitionPages)
      && operation.parameters?.transition === transition && operation.parameters?.duration === duration,
  }, 'pages.transitions', 'source-bound-incremental-dissolve-transition', { pages: transitionPages, transition, duration });
}

function unsupportedCapability(capabilityId, message) {
  return async () => fail('PAGES_CAPABILITY_UNSUPPORTED', message, 422);
}

export const pagesResize = unsupportedCapability('pages.resize', 'Validated page resizing with content placement is unavailable.');

function generatedBlankId(value) {
  return value?.documentId ?? value?.document?.id ?? value?.artifact?.documentId ?? value?.id ?? null;
}

function generatedBlankDigest(value, document) {
  return value?.sourceSha256 ?? value?.sha256 ?? value?.document?.sha256 ?? document?.sha256 ?? null;
}

async function revokeGeneratedBlank(ctx, generated) {
  if (!generated) return;
  const documentId = generatedBlankId(generated);
  const artifactId = generated?.artifact?.id;
  try {
    if (artifactId && typeof ctx.store?.deleteArtifact === 'function') {
      await ctx.store.deleteArtifact(artifactId);
      return;
    }
    if (documentId && typeof ctx.store?.deleteDocument === 'function') {
      await ctx.store.deleteDocument(documentId);
      return;
    }
  } catch (error) {
    fail('PAGES_CLEANUP_FAILED', 'The generated blank-page source could not be revoked.', 500, error);
  }
  outputInvalid('The generated blank-page source has no cleanup authority.');
}

async function inspectGeneratedBlank(ctx, generated) {
  const documentId = generatedBlankId(generated);
  const sourceSha256 = generatedBlankDigest(generated);
  if (typeof documentId !== 'string' || !/^[0-9a-f]{64}$/u.test(String(sourceSha256 ?? ''))) {
    outputInvalid('The authoritative blank-page factory returned an unbound source.');
  }
  let document;
  try {
    document = ctx.store.getDocument(documentId);
    await ctx.store.verifySource(documentId);
  } catch {
    outputInvalid('The authoritative blank-page source could not be verified.');
  }
  if (!document || document.sha256 !== sourceSha256 || document.mediaType !== 'application/pdf') {
    outputInvalid('The authoritative blank-page source digest does not match its retained document.');
  }
  const inspector = service(ctx, 'inspect');
  const inspection = await inspector.inspect(documentId, { signal: ctx.signal });
  const geometry = typeof inspector.inspectPage === 'function'
    ? await inspector.inspectPage(documentId, 1, { signal: ctx.signal })
    : null;
  const textPages = typeof inspector.extractText === 'function'
    ? await inspector.extractText(documentId, 1, { signal: ctx.signal })
    : null;
  if (inspection?.pageCount !== 1 || !geometry
    || geometry.page !== 1 || geometry.widthPoints !== STANDARD_BLANK_PAGE.widthPoints
    || geometry.heightPoints !== STANDARD_BLANK_PAGE.heightPoints
    || !Array.isArray(textPages) || textPages.length !== 1 || String(textPages[0]?.text ?? '') !== '') {
    outputInvalid('The authoritative blank-page source was not one standard, text-empty page.');
  }
  return Object.freeze({ document, documentId, sourceSha256, geometry });
}

function abortBlankInsertion(ctx) {
  if (ctx.signal?.aborted) fail('JOB_CANCELLED', 'Blank-page insertion was cancelled.', 499);
}

export async function pagesInsertBlank(ctx = {}) {
  abortBlankInsertion(ctx);
  const binding = await sources(ctx);
  const afterPage = ctx.afterPage;
  if (!Number.isSafeInteger(afterPage) || afterPage < 1) invalid('afterPage must select one existing page after which to insert the blank page.');
  const primaryInspection = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  if (!Number.isSafeInteger(primaryInspection?.pageCount) || afterPage > primaryInspection.pageCount) {
    invalid('afterPage is outside the primary source document.');
  }
  const factory = ctx.blankPageFactory;
  if (!factory || typeof factory.createBlank !== 'function') {
    unavailable('Blank-page insertion requires the authoritative local blank-page factory.');
  }
  let generated = null;
  try {
    generated = await factory.createBlank({ pages: 1, ...STANDARD_BLANK_PAGE, title: 'Inserted blank page' }, { signal: ctx.signal });
    abortBlankInsertion(ctx);
    const blank = await inspectGeneratedBlank(ctx, generated);
    const inserter = service(ctx, 'insertDocument');
    const artifact = await inserter.insertDocument(binding.primary.id, blank.documentId, afterPage, {
      operationType: 'insert-blank-page', fileLabel: 'blank-inserted',
      sourceSha256: binding.primary.sha256, secondarySourceSha256: blank.sourceSha256, signal: ctx.signal,
    });
    abortBlankInsertion(ctx);
    const selections = [
      ...Array.from({ length: afterPage }, (_, index) => ({ input: 0, page: index + 1 })),
      { input: 1, page: 1 },
      ...Array.from({ length: primaryInspection.pageCount - afterPage }, (_, index) => ({ input: 0, page: afterPage + index + 1 })),
    ];
    const outcome = await complete(ctx, binding, artifact, {
      type: 'insert-blank-page',
      inputs: [
        { documentId: binding.primary.id, sha256: binding.primary.sha256, role: 'primary' },
        { documentId: blank.documentId, sha256: blank.sourceSha256, role: 'source-1' },
      ],
      expectedPageCount: primaryInspection.pageCount + 1,
      selections,
      validation: ['source-sha256', 'pdfinfo-page-count', 'semantic-page-manifest'],
      extra: (operation) => operation.parameters?.afterPage === afterPage
        && JSON.stringify(operation.parameters?.selections) === JSON.stringify(selections)
        && operation.validation?.manifestSha256 === operation.expected?.manifestSha256,
    }, 'pages.insert-blank', 'source-bound-poppler-insert-blank', { afterPage, blankSourceSha256: blank.sourceSha256 });

    // Independently reread the retained output through the authoritative inspector.
    if (typeof ctx.store.createDocument !== 'function' || typeof ctx.store.deleteDocument !== 'function') {
      unavailable('Blank-page insertion requires temporary-output inspection and cleanup authority.');
    }
    let reread = null;
    try {
      reread = await ctx.store.createDocument({ stream: (await import('node:stream')).Readable.from([outcome.pdf]), displayName: 'blank-inserted-proof.pdf' });
      const outputInspection = await service(ctx, 'inspect').inspect(reread.id, { signal: ctx.signal });
      const insertedGeometry = await service(ctx, 'inspect').inspectPage(reread.id, afterPage + 1, { signal: ctx.signal });
      const outputText = await service(ctx, 'inspect').extractText(reread.id, outputInspection.pageCount, { signal: ctx.signal });
      if (outputInspection.pageCount !== primaryInspection.pageCount + 1
        || insertedGeometry?.page !== afterPage + 1
        || insertedGeometry?.widthPoints !== STANDARD_BLANK_PAGE.widthPoints
        || insertedGeometry?.heightPoints !== STANDARD_BLANK_PAGE.heightPoints
        || String(outputText?.[afterPage]?.text ?? '') !== '') {
        outputInvalid('The retained blank-page output failed page-count, geometry, or empty-text verification.');
      }
    } finally {
      if (reread) await ctx.store.deleteDocument(reread.id);
    }
    return outcome;
  } finally {
    await revokeGeneratedBlank(ctx, generated);
  }
}
