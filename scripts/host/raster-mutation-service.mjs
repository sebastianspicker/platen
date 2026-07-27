import { join } from 'node:path';
import { digestFile } from './document-store.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { HostError } from './host-error.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { assertPng as assertPipelinePng, jobSignal as createPipelineJobSignal, workspaceBytes as measurePipelineWorkspace } from './raster-mutation-helpers.mjs';
import { RasterRedactionVerification } from './raster-redaction-verification.mjs';
import {
  MAX_RASTER_DIMENSION,
  MAX_RASTER_JOB_MS,
  MAX_RASTER_WORKSPACE_BYTES,
  assertRasterOperation,
  createRasterTransform,
  pageSet,
  parsePageCount,
  parsePageDimensions,
  publicRasterParameters,
  scaledDimensions,
} from './raster-mutation-contract.mjs';

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export class RasterMutationService {
  #store; #poppler; #imageMagick; #raster; #redactionVerification;
  constructor({ store, poppler, imageMagick, raster } = {}) {
    if (!store || !poppler || !imageMagick || !raster || typeof raster.analyzeRegion !== 'function') throw new TypeError('RasterMutationService requires a document store, Poppler, ImageMagick, and raster mutation adapter.');
    this.#store = store; this.#poppler = poppler; this.#imageMagick = imageMagick; this.#raster = raster;
    this.#redactionVerification = new RasterRedactionVerification({ poppler, raster });
  }
  rotatePages(documentId, parameters = {}, options) { return this.mutate(documentId, { ...parameters, operation: 'rotate' }, options); }
  cropPages(documentId, parameters = {}, options) { return this.mutate(documentId, { ...parameters, operation: 'crop' }, options); }
  resizePages(documentId, parameters = {}, options) { return this.mutate(documentId, { ...parameters, operation: 'resize' }, options); }
  addOverlayText(documentId, parameters = {}, options) { return this.mutate(documentId, { ...parameters, operation: 'overlay' }, options); }
  redact(documentId, parameters = {}, options) { return this.mutate(documentId, { ...parameters, operation: 'redact' }, options); }
  flatten(documentId, parameters = {}, options) { return this.mutate(documentId, { ...parameters, operation: 'flatten' }, options); }

  async mutate(documentId, parameters = {}, { signal: externalSignal } = {}) {
    const operation = parameters.operation;
    assertRasterOperation(operation);
    const source = this.#store.getDocument(documentId);
    if (operation === 'redact') {
      this.#redactionVerification.assertAdmission(parameters, source.sha256);
    }
    await this.#store.verifySource(documentId);
    if (source.size > MAX_RASTER_WORKSPACE_BYTES) {
      fail('RASTER_INPUT_TOO_LARGE', 'Raster mutation input exceeds the private workspace limit.', 413);
    }
    const storedSourcePath = this.#store.getSourcePath(documentId);
    const workspace = await this.#store.createJobWorkspace(documentId);
    const job = createPipelineJobSignal(externalSignal);
    try {
      const sourcePath = join(workspace, 'immutable-source.pdf');
      let sourceIdentity;
      try {
        sourceIdentity = await stagePrivateSourceCopy({
          sourcePath: storedSourcePath, targetPath: sourcePath,
          expectedSha256: source.sha256, expectedSize: source.size,
          maximumBytes: MAX_RASTER_WORKSPACE_BYTES,
        });
      } catch (error) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', 'Raster mutation could not bind a private immutable source copy.', 500, { cause: error });
      }
      const info = await this.#poppler.execute('inspect', { input: sourcePath });
      const pageCount = parsePageCount(info.stdout);
      if (operation === 'redact') {
        await this.#redactionVerification.assertSourceSupported(sourcePath, workspace, job.signal, info.stdout);
      }
      const pages = pageSet(parameters.pages, pageCount);
      const geometry = new Map();
      for (let page = 1; page <= pageCount; page += 1) {
        const inspected = await this.#poppler.execute('inspectPage', { input: sourcePath, page }, { signal: job.signal, timeoutMs: MAX_RASTER_JOB_MS });
        const points = parsePageDimensions(inspected.stdout, page);
        geometry.set(page, Object.freeze({
          mutation: scaledDimensions(points.widthPoints, points.heightPoints),
          validation: scaledDimensions(points.widthPoints, points.heightPoints, 512),
          text: Object.freeze({ width: Math.ceil(points.cropWidthPoints), height: Math.ceil(points.cropHeightPoints) }),
          rotation: points.rotation,
          cropMatchesMedia: points.cropMatchesMedia,
        }));
      }
      const redactions = operation === 'redact'
        ? this.#redactionVerification.validateTargets(parameters.redactions, pages, pageCount, geometry)
        : [];
      if (operation === 'redact') await this.#redactionVerification.assertSourceText(sourcePath, redactions, geometry, job.signal);
      const pagePdfs = [];
      const redactionProof = { targetPixelCount: 0, nonTargetChangedPixels: 0 };
      for (let page = 1; page <= pageCount; page += 1) {
        const renderedPrefix = join(workspace, `source-${page}`); const rendered = `${renderedPrefix}.png`;
        await this.#poppler.execute('renderPagePng', { input: sourcePath, outputPrefix: renderedPrefix, page, maxDimension: MAX_RASTER_DIMENSION }, { signal: job.signal, timeoutMs: MAX_RASTER_JOB_MS });
        const sourcePng = await assertPipelinePng(rendered);
        const transformed = join(workspace, `mutated-${page}.png`); const active = pages.has(page);
        const dimensions = geometry.get(page).mutation;
        const transform = active
          ? createRasterTransform(operation, parameters, page, dimensions, redactions)
          : {};
        await this.#raster.mutate({ input: rendered, output: transformed, workspace, ...transform }, { signal: job.signal, timeoutMs: MAX_RASTER_JOB_MS, maxStdoutBytes: 128 * 1024, maxStderrBytes: 256 * 1024 });
        const transformedPng = await assertPipelinePng(transformed);
        if (operation === 'redact') {
          const proof = this.#redactionVerification.verifyRenderedPage(
            sourcePng, transformedPng, redactions.filter((item) => item.page === page),
          );
          redactionProof.targetPixelCount += proof.targetPixelCount;
          redactionProof.nonTargetChangedPixels += proof.nonTargetChangedPixels;
        }
        const pagePdf = join(workspace, `page-${page}.pdf`);
        await this.#imageMagick.execute('convertRasterToPdf', { input: transformed, output: pagePdf, workspace }, { signal: job.signal, timeoutMs: MAX_RASTER_JOB_MS, maxStdoutBytes: 128 * 1024, maxStderrBytes: 256 * 1024 });
        pagePdfs.push(pagePdf);
        if (await measurePipelineWorkspace(workspace) > MAX_RASTER_WORKSPACE_BYTES) fail('JOB_WORKSPACE_LIMIT', 'Raster mutation exceeded the local workspace quota.', 413);
      }
      const output = pagePdfs.length === 1 ? pagePdfs[0] : join(workspace, 'mutated.pdf');
      if (pagePdfs.length > 1) await this.#poppler.execute('mergeDocuments', { inputs: pagePdfs, output }, { signal: job.signal, timeoutMs: MAX_RASTER_JOB_MS });
      const validation = await this.#validateOutput(output, pageCount, operation, redactions, geometry, redactionProof, job.signal, workspace);
      try {
        await assertPrivateSourceCopy({
          path: sourcePath, identity: sourceIdentity,
          expectedSha256: source.sha256, expectedSize: source.size,
          maximumBytes: MAX_RASTER_WORKSPACE_BYTES,
        });
      } catch (error) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', 'Raster mutation source copy changed during native processing.', 500, { cause: error });
      }
      await this.#store.verifySource(documentId);
      const provenance = createOperationProvenance({
        type: `raster-${operation}`, inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
        parameters: publicRasterParameters(operation, parameters, redactions),
        expected: { pageCount, rasterized: true, destroys: ['vectors', 'forms', 'links', 'tags', 'signatures'] }, validation,
      });
      const expectedSha256 = await digestFile(output);
      return await this.#store.promotePdfArtifact(documentId, output, {
        displayName: `raster-${operation}-${source.displayName}`,
        operation: provenance,
        expectedSha256,
        signal: job.signal,
      });
    } catch (error) {
      if (job.timedOut || error?.code === 'ENGINE_TIMEOUT') throw new HostError('RASTER_MUTATION_TIMEOUT', 'Raster mutation exceeded its two-minute local deadline.', 504, { cause: error });
      if (job.signal.aborted || error?.code === 'ENGINE_CANCELLED') throw new HostError('JOB_CANCELLED', 'Raster mutation was cancelled.', 499, { cause: error });
      throw error;
    } finally { job.dispose(); await this.#store.cleanupJob(workspace).catch(() => {}); }
  }
  async #validateOutput(output, expectedPages, operation, redactions, geometry, redactionProof, signal, workspace) {
    const inspection = await this.#poppler.execute('inspect', { input: output }, { signal, timeoutMs: MAX_RASTER_JOB_MS });
    const pageCount = parsePageCount(inspection.stdout); if (pageCount !== expectedPages) fail('INVALID_ENGINE_OUTPUT', 'Raster mutation changed the PDF page count.', 502);
    for (let page = 1; page <= pageCount; page += 1) {
      const prefix = join(workspace, `validated-${page}`); await this.#poppler.execute('renderPagePng', { input: output, outputPrefix: prefix, page, maxDimension: 512 }, { signal, timeoutMs: MAX_RASTER_JOB_MS }); await assertPipelinePng(`${prefix}.png`);
      if (operation === 'redact') {
        await this.#redactionVerification.assertOutputPage(
          `${prefix}.png`, redactions.filter((item) => item.page === page),
          geometry.get(page).validation, workspace, signal, 0.02,
        );
      }
    }
    const validators = ['poppler-page-count', 'poppler-render-png', 'raster-output'];
    const validation = { passed: true, validators, pageCount, rasterized: true };
    if (operation === 'redact') {
      await this.#redactionVerification.completeOutputValidation({
        output, inspection: inspection.stdout, redactions, redactionProof, signal, workspace, validation,
      });
    }
    return validation;
  }
}
