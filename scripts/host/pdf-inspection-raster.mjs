import { join } from 'node:path';
import {
  mapEngineError, MAX_JOB_WORKSPACE_BYTES, MAX_SNAPSHOT_PIXELS, MAX_THUMBNAIL_BYTES,
  parsePdfInfo, PNG_SIGNATURE, readRegularOutput, renderDimensionForDpi, validatePages,
} from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { cropPngRegion } from './raster-snapshot.mjs';
import { decodePng } from './raster-png-codec.mjs';

const MAX_OVERLAY_PIXELS = 4_194_304;

function assertPng(bytes, label) {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new HostError('INVALID_ENGINE_OUTPUT', `Poppler ${label} output is not a PNG image.`, 502);
  }
}

function overlayDimensions({ widthPoints, heightPoints, rotation }, dpi) {
  const rotated = rotation === 90 || rotation === 270;
  const renderedWidth = rotated ? heightPoints : widthPoints;
  const renderedHeight = rotated ? widthPoints : heightPoints;
  const bounds = (points) => [Math.floor((points * dpi) / 72), Math.ceil((points * dpi) / 72)];
  const [minimumWidth, maximumWidth] = bounds(renderedWidth); const [minimumHeight, maximumHeight] = bounds(renderedHeight);
  if (minimumWidth < 1 || minimumHeight < 1 || maximumWidth > 8192 || maximumHeight > 8192
    || maximumWidth > Math.floor(MAX_OVERLAY_PIXELS / maximumHeight)) {
    throw new HostError('OVERLAY_RENDER_LIMIT', 'Exact-DPI overlay rendering exceeds bounded raster dimensions.', 422);
  }
  return Object.freeze({ minimumWidth, maximumWidth, minimumHeight, maximumHeight });
}

export class PdfInspectionRaster {
  #store; #adapter; #inspectPage;
  constructor({ store, adapter, inspectPage }) { this.#store = store; this.#adapter = adapter; this.#inspectPage = inspectPage; }
  async renderThumbnail(documentId, { page, dpi = 96, signal } = {}) {
    const input = this.#store.getSourcePath(documentId);
    await this.#inspectPage(documentId, page, { signal });
    const maxDimension = renderDimensionForDpi(dpi);
    const workspace = await this.#store.createJobWorkspace(documentId);
    const outputPrefix = join(workspace, 'thumbnail'); const outputPath = `${outputPrefix}.png`;
    try {
      await this.#adapter.execute('renderPagePng', { input, outputPrefix, page, maxDimension }, { cwd: workspace, signal, timeoutMs: 30_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024 });
      const bytes = await readRegularOutput(outputPath, { maximumBytes: MAX_THUMBNAIL_BYTES, label: 'Poppler thumbnail PNG' });
      assertPng(bytes, 'thumbnail');
      return bytes;
    } catch (error) { throw mapEngineError(error); } finally { await this.#store.cleanupJob(workspace); }
  }
  async renderOverlayPageExactDpi(documentId, { page, dpi = 72, signal } = {}) {
    const input = this.#store.getSourcePath(documentId);
    const expected = overlayDimensions(await this.#inspectPage(documentId, page, { signal }), dpi);
    const workspace = await this.#store.createJobWorkspace(documentId);
    const outputPrefix = join(workspace, 'overlay-exact-dpi'); const outputPath = `${outputPrefix}.png`;
    try {
      await this.#adapter.execute('renderOverlayExactDpiPng', { input, outputPrefix, page, dpi }, { cwd: workspace, signal, timeoutMs: 30_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024 });
      const bytes = await readRegularOutput(outputPath, { maximumBytes: MAX_THUMBNAIL_BYTES, label: 'Poppler exact-DPI overlay PNG' });
      const decoded = decodePng(bytes, MAX_OVERLAY_PIXELS);
      if (decoded.width < expected.minimumWidth || decoded.width > expected.maximumWidth
        || decoded.height < expected.minimumHeight || decoded.height > expected.maximumHeight) {
        throw new HostError('INVALID_ENGINE_OUTPUT', 'Poppler exact-DPI overlay PNG dimensions do not match the inspected page geometry.', 502);
      }
      return bytes;
    } catch (error) { throw mapEngineError(error); } finally { await this.#store.cleanupJob(workspace); }
  }
  async renderCropBoxPage(documentId, { page, dpi = 192, signal } = {}) {
    const source = this.#store.getDocument(documentId);
    if (source.size > MAX_JOB_WORKSPACE_BYTES) throw new HostError('DOCUMENT_TOO_LARGE', 'CropBox rendering input exceeds the private workspace limit.', 413);
    const maxDimension = renderDimensionForDpi(dpi);
    await this.#store.verifySource(documentId);
    const storedSourcePath = this.#store.getSourcePath(documentId);
    const workspace = await this.#store.createJobWorkspace(documentId);
    const input = join(workspace, 'immutable-source.pdf'); const outputPrefix = join(workspace, 'cropbox-page'); const outputPath = `${outputPrefix}.png`;
    try {
      let sourceIdentity;
      try { sourceIdentity = await stagePrivateSourceCopy({ sourcePath: storedSourcePath, targetPath: input, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_JOB_WORKSPACE_BYTES }); } catch (error) { throw new HostError('SOURCE_INTEGRITY_FAILED', 'CropBox rendering could not bind a private immutable source copy.', 500, { cause: error }); }
      const inspection = parsePdfInfo((await this.#adapter.execute('inspect', { input }, { cwd: workspace, signal, timeoutMs: 15_000, maxStdoutBytes: 512 * 1024, maxStderrBytes: 64 * 1024 })).stdout);
      validatePages([page], inspection.pageCount);
      await this.#adapter.execute('renderCropBoxPagePng', { input, outputPrefix, page, maxDimension }, { cwd: workspace, signal, timeoutMs: 30_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024 });
      const bytes = await readRegularOutput(outputPath, { maximumBytes: MAX_THUMBNAIL_BYTES, label: 'Poppler CropBox PNG' });
      assertPng(bytes, 'CropBox');
      try { await assertPrivateSourceCopy({ path: input, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_JOB_WORKSPACE_BYTES }); } catch (error) { throw new HostError('SOURCE_INTEGRITY_FAILED', 'CropBox rendering source copy changed during native processing.', 500, { cause: error }); }
      await this.#store.verifySource(documentId);
      return bytes;
    } catch (error) { throw mapEngineError(error); } finally { await this.#store.cleanupJob(workspace); }
  }
  async renderCropBoxSnapshot(documentId, { page, dpi = 192, region, signal } = {}) {
    const renderedPage = await this.renderCropBoxPage(documentId, { page, dpi, signal });
    return cropPngRegion(renderedPage, region, MAX_SNAPSHOT_PIXELS).png;
  }
}
