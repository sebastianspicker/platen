import { decodePng } from './raster-png-codec.mjs';
import { HostError } from './host-error.mjs';
import {
  executeOfflineSignatureInspection, parseAttachments, parseDocumentUrls, parsePdfInfo,
} from './pdf-service-foundation.mjs';
import {
  MAX_RASTER_JOB_MS,
  VERIFIED_RASTER_BURN_PROFILE,
  assertVerifiedRedactionProfile,
  insetRasterRegion,
  rasterRegion,
  validateRasterRedactions,
} from './raster-mutation-contract.mjs';

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

/** Security admission and verification for the verified raster-redaction profile. */
export class RasterRedactionVerification {
  #poppler; #raster;

  constructor({ poppler, raster } = {}) {
    if (!poppler || !raster || typeof raster.analyzeRegion !== 'function') throw new TypeError('RasterRedactionVerification requires Poppler and a raster region analysis adapter.');
    this.#poppler = poppler;
    this.#raster = raster;
  }

  assertAdmission(parameters, sourceSha256) { assertVerifiedRedactionProfile(parameters, sourceSha256); }

  async assertSourceSupported(input, workspace, signal, inspection) {
    const sourceInfo = parsePdfInfo(inspection);
    if (String(sourceInfo.encrypted).toLowerCase() !== 'no') {
      fail('REDACTION_SOURCE_UNSUPPORTED', 'Verified raster redaction requires an unencrypted source PDF.', 422);
    }
    await this.#assertUnsignedPdf(
      input, workspace, signal,
      'REDACTION_SIGNED_SOURCE_UNSUPPORTED',
      'Verified raster redaction rejects signed or indeterminate-signature source PDFs.',
      422,
    );
  }

  validateTargets(redactions, pages, pageCount, geometry) {
    return validateRasterRedactions(redactions, pages, pageCount, geometry);
  }

  async assertSourceText(input, redactions, geometry, signal) {
    const normalize = (value) => String(value).trim().replace(/\s+/gu, ' ');
    for (const redaction of redactions) {
      const region = rasterRegion(redaction.region, geometry.get(redaction.page).text);
      const source = await this.#poppler.execute('extractTextRegion', {
        input, page: redaction.page, region,
      }, { signal, timeoutMs: MAX_RASTER_JOB_MS, maxStdoutBytes: 256 * 1024 });
      if (!normalize(source.stdout).includes(normalize(redaction.removedText))) {
        fail('REDACTION_TEXT_NOT_FOUND', `Marked source text was not found inside the selected region on page ${redaction.page}.`, 422);
      }
    }
  }

  verifyRenderedPage(sourcePng, transformedPng, redactions) {
    const source = decodePng(sourcePng);
    const transformed = decodePng(transformedPng);
    if (source.width !== transformed.width || source.height !== transformed.height) {
      fail('REDACTION_PIXEL_VALIDATION_FAILED', 'Raster redaction changed the rendered page dimensions.', 502);
    }
    const mask = Buffer.alloc(source.width * source.height);
    for (const redaction of redactions) {
      const region = rasterRegion(redaction.region, source);
      for (let y = region.y; y < region.y + region.height; y += 1) {
        mask.fill(1, (y * source.width) + region.x, (y * source.width) + region.x + region.width);
      }
    }
    let targetPixelCount = 0;
    let nonTargetChangedPixels = 0;
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      const offset = pixel * 4;
      if (mask[pixel]) {
        targetPixelCount += 1;
        if (transformed.pixels[offset] !== 0 || transformed.pixels[offset + 1] !== 0
          || transformed.pixels[offset + 2] !== 0 || transformed.pixels[offset + 3] !== 255) {
          fail('REDACTION_PIXEL_VALIDATION_FAILED', 'A target pixel was not replaced with opaque black.', 502);
        }
      } else if (transformed.pixels[offset] !== source.pixels[offset]
        || transformed.pixels[offset + 1] !== source.pixels[offset + 1]
        || transformed.pixels[offset + 2] !== source.pixels[offset + 2]
        || transformed.pixels[offset + 3] !== source.pixels[offset + 3]) {
        nonTargetChangedPixels += 1;
      }
    }
    if (nonTargetChangedPixels !== 0) {
      fail('REDACTION_PIXEL_VALIDATION_FAILED', 'Raster redaction changed pixels outside the selected regions.', 502);
    }
    return Object.freeze({ targetPixelCount, nonTargetChangedPixels });
  }

  async assertOutputPage(input, redactions, dimensions, workspace, signal, maximum) {
    for (const redaction of redactions) {
      const region = insetRasterRegion(rasterRegion(redaction.region, dimensions));
      const result = await this.#raster.analyzeRegion({ input, workspace, region }, {
        signal, timeoutMs: MAX_RASTER_JOB_MS, maxStdoutBytes: 128, maxStderrBytes: 64 * 1024,
      });
      const observedMaximum = Number(String(result.stdout ?? '').trim());
      if (!Number.isFinite(observedMaximum) || observedMaximum < 0 || observedMaximum > maximum) {
        fail('REDACTION_VISUAL_VALIDATION_FAILED', 'A redaction region was not rendered as an opaque black area.', 502);
      }
    }
  }

  async completeOutputValidation({ output, inspection, redactions, redactionProof, signal, workspace, validation }) {
    const outputInfo = parsePdfInfo(inspection);
    const expectedWriterMetadata = (
      outputInfo.title === 'page-1'
      && outputInfo.author === 'https://imagemagick.org'
      && outputInfo.creator === 'https://imagemagick.org'
      && outputInfo.producer === 'https://imagemagick.org'
    ) || (!outputInfo.title && !outputInfo.author && !outputInfo.creator && !outputInfo.producer);
    if (String(outputInfo.encrypted).toLowerCase() !== 'no'
      || String(outputInfo.tagged).toLowerCase() !== 'no'
      || String(outputInfo.form).toLowerCase() !== 'none'
      || String(outputInfo.javascript).toLowerCase() !== 'no'
      || !expectedWriterMetadata || outputInfo.subject || outputInfo.keywords) {
      fail('REDACTION_SANITIZATION_FAILED', 'The redacted PDF retained unexpected active structure or metadata.', 502);
    }
    const attachmentOutput = await this.#poppler.execute('listAttachments', { input: output }, { signal, timeoutMs: MAX_RASTER_JOB_MS });
    const urlOutput = await this.#poppler.execute('inspectUrls', { input: output }, { signal, timeoutMs: MAX_RASTER_JOB_MS });
    if (parseAttachments(attachmentOutput.stdout).length || parseDocumentUrls(urlOutput.stdout).length) {
      fail('REDACTION_SANITIZATION_FAILED', 'The redacted PDF retained attachments or object URLs.', 502);
    }
    await this.#assertUnsignedPdf(output, workspace, signal, 'REDACTION_SANITIZATION_FAILED', 'The redacted PDF did not validate as an unsigned raster output.', 502);
    const text = await this.#poppler.execute('extractText', { input: output, layout: false }, { signal, timeoutMs: MAX_RASTER_JOB_MS });
    if (String(text.stdout).trim()) fail('REDACTION_VALIDATION_FAILED', 'The raster-redacted PDF retained extractable source text.', 502);
    validation.validators.push(
      'source-sha256', 'poppler-region-text-binding',
      'png-target-opaque-black', 'png-nontarget-pixel-equality', 'poppler-post-pdf-black-region',
      'pdftotext-empty-raster', 'pdfinfo-passive-raster',
      'pdfdetach-no-attachments', 'pdfinfo-no-object-urls', 'pdfsig-output-unsigned',
    );
    validation.redactionCount = redactions.length;
    validation.targetCount = redactions.length;
    validation.profile = VERIFIED_RASTER_BURN_PROFILE;
    validation.targetPixelCount = redactionProof.targetPixelCount;
    validation.nonTargetChangedPixels = redactionProof.nonTargetChangedPixels;
    validation.verifiedPages = [...new Set(redactions.map(({ page }) => page))].sort((left, right) => left - right);
    validation.extractableTextPresent = false;
    validation.attachmentsPresent = false;
    validation.objectUrlsPresent = false;
    validation.signaturesPresent = false;
    validation.sensitiveTextRetained = false;
  }

  async #assertUnsignedPdf(input, nssDirectory, signal, code, message, status) {
    let signatures;
    try {
      signatures = await executeOfflineSignatureInspection(this.#poppler, { input, nssDirectory, signal, timeoutMs: 30_000 });
    } catch (error) {
      if (signal?.aborted || error?.code === 'ENGINE_TIMEOUT' || error?.code === 'ENGINE_CANCELLED') throw error;
      fail(code, message, status);
    }
    if (signatures.status !== 'unsigned' || signatures.signatureCount !== 0) fail(code, message, status);
  }
}
