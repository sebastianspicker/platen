import { HostError } from '../host-error.mjs';
import {
  boxesMatch,
  configuredLimits,
  fail,
  pageGeometryMatches,
} from './prepress-support.mjs';
import { runBoundedPrepressJob } from './job-runtime.mjs';
import { validateDerivedPdf } from './derived-output-validation.mjs';
import { createPrepressOutputValidator } from './prepress-output-validation.mjs';

/**
 * Stable capability carrier for prepress operations. Bounded job lifecycle and
 * derived-PDF checks live in focused modules to keep their security contracts
 * independently readable.
 */
export class PrepressServiceCore {
  #store;
  #pdf;
  #poppler;
  #ghostscript;
  #imageMagick;
  #profiles;
  #limits;
  #output;

  constructor({
    store,
    pdfService,
    poppler = null,
    ghostscript,
    imageMagick,
    iccProfileProvider = null,
    limits,
  } = {}) {
    if (!store || typeof store.getDocument !== 'function' ||
      typeof store.getSourcePath !== 'function' ||
      typeof store.verifySource !== 'function' ||
      typeof store.createJobWorkspace !== 'function' ||
      typeof store.cleanupJob !== 'function' ||
      typeof store.deleteArtifact !== 'function') {
      throw new TypeError('PrepressService requires a DocumentStore-compatible store.');
    }
    if (!pdfService || typeof pdfService.inspect !== 'function' ||
      typeof pdfService.inspectPage !== 'function') {
      throw new TypeError('PrepressService requires PdfService document and page inspection.');
    }
    if (!ghostscript || typeof ghostscript.execute !== 'function' ||
      !imageMagick || typeof imageMagick.execute !== 'function') {
      throw new TypeError('PrepressService requires Ghostscript and ImageMagick adapters.');
    }
    if (poppler !== null && typeof poppler?.execute !== 'function') {
      throw new TypeError('poppler must expose execute(operation, parameters).');
    }
    if (iccProfileProvider !== null &&
      typeof iccProfileProvider?.stageDefaultCmyk !== 'function') {
      throw new TypeError('iccProfileProvider must expose stageDefaultCmyk(workspace).');
    }
    this.#store = store;
    this.#pdf = pdfService;
    this.#poppler = poppler;
    this.#ghostscript = ghostscript;
    this.#imageMagick = imageMagick;
    this.#profiles = iccProfileProvider;
    this.#limits = configuredLimits(limits);
    this.#output = createPrepressOutputValidator(this.#limits);
  }

  get store() { return this.#store; }
  get pdf() { return this.#pdf; }
  get poppler() { return this.#poppler; }
  get ghostscript() { return this.#ghostscript; }
  get imageMagick() { return this.#imageMagick; }
  get profiles() { return this.#profiles; }
  get limits() { return this.#limits; }

  withSource(documentId, externalSignal, action) {
    return runBoundedPrepressJob(this, documentId, externalSignal, action);
  }

  assertRegular(...args) { return this.#output.assertRegular(...args); }
  assertInventory(...args) { return this.#output.assertInventory(...args); }
  listWorkspace(...args) { return this.#output.listWorkspace(...args); }
  readBoundedFile(...args) { return this.#output.readBoundedFile(...args); }
  readPreview(...args) { return this.#output.readPreview(...args); }
  validateTiff(...args) { return this.#output.validateTiff(...args); }

  assertArtifactStack({ icc = false } = {}) {
    if (!this.#poppler || typeof this.#store.promotePdfArtifact !== 'function' ||
      typeof this.#store.deleteArtifact !== 'function' ||
      typeof this.#ghostscript.probe !== 'function' || (icc && !this.#profiles)) {
      fail('PREPRESS_ARTIFACT_UNAVAILABLE', 'Validated local prepress artifact creation is unavailable.', 503);
    }
  }

  assertArtifactSource(info) {
    if (info.pageCount > this.#limits.maxArtifactPages) {
      fail('PREPRESS_ARTIFACT_PAGE_LIMIT', `Validated prepress artifacts are limited to ${this.#limits.maxArtifactPages} pages.`, 422);
    }
    if (String(info.encrypted ?? '').toLowerCase() !== 'no') {
      fail('PREPRESS_ARTIFACT_ENCRYPTED', 'Validated prepress artifacts require an unencrypted source PDF.', 422);
    }
    if (String(info.javascript ?? '').toLowerCase() !== 'no' ||
      String(info.form ?? '').toLowerCase() !== 'none') {
      fail('PREPRESS_ARTIFACT_ACTIVE_CONTENT', 'Validated prepress artifacts require a JavaScript-free, form-free source PDF.', 422);
    }
  }

  async artifactStructure(documentId, pageCount, signal) {
    if (typeof this.#pdf.inspectStructure !== 'function') {
      fail('PREPRESS_ARTIFACT_UNAVAILABLE', 'Full page-box inspection is unavailable.', 503);
    }
    const structure = await this.#pdf.inspectStructure(documentId, {
      firstPage: 1,
      lastPage: pageCount,
      signal,
    });
    if (structure.sourceDigest !== undefined &&
      structure.sourceDigest !== this.#store.getDocument(documentId).sha256) {
      fail('PREPRESS_ARTIFACT_SOURCE_MISMATCH', 'Page-box evidence did not bind to the immutable source.', 500);
    }
    if (structure.pageRange?.firstPage !== 1 || structure.pageRange?.lastPage !== pageCount ||
      structure.pageRange?.truncated || structure.pageBoxes?.length !== pageCount) {
      fail('PREPRESS_ARTIFACT_GEOMETRY_INCOMPLETE', 'Validated prepress artifacts require complete page-box evidence.', 502);
    }
    return structure;
  }

  uniformImpositionGeometry(pageBoxes) {
    const first = pageBoxes[0];
    const media = first?.boxes?.mediaBox;
    const crop = first?.boxes?.cropBox;
    if (!first || first.rotation !== 0 || !media || !crop || !boxesMatch(media, crop) ||
      Math.abs(media.left) > 0.01 || Math.abs(media.bottom) > 0.01) {
      fail('IMPOSITION_GEOMETRY_UNSUPPORTED', 'N-up requires unrotated pages whose zero-origin CropBox matches the MediaBox.', 422);
    }
    for (const current of pageBoxes.slice(1)) {
      if (!pageGeometryMatches(first, current)) {
        fail('IMPOSITION_GEOMETRY_UNSUPPORTED', 'N-up requires one identical page geometry and rotation throughout the source.', 422);
      }
    }
    return Object.freeze({ widthPoints: media.width, heightPoints: media.height, rotation: 0 });
  }

  validateDerivedPdf(options) {
    return validateDerivedPdf(this, options);
  }
}
