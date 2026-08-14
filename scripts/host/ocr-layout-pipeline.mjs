import {
  cropDimensions, decodeUtf8, MAX_OCR_ALTO_BYTES, MAX_OCR_LAYOUT_PAGES, MAX_OCR_LAYOUT_RESULT_BYTES, MAX_OCR_LAYOUT_ZONES, MAX_OCR_RASTER_BYTES, MAX_OCR_TSV_BYTES, MAX_OCR_ZONES_PER_PAGE,
  ocrDpi, ocrZonesOverlap, pngDimensions, readRegularOutput, strictOcrZone, validateAltoEvidence, validateOcrMode, validatePngOutput,
} from './pdf-service-foundation.mjs';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import { exportOcrLayoutJson, parseTesseractTsvHierarchy } from './ocr-layout.mjs';
import { ocrLanguages, validateOcrLanguage, withOcrWorkspace } from './ocr-job-helpers.mjs';

export class OcrLayoutPipeline {
  #store; #adapter; #ocrAdapter; #ocrImageAdapter; #inspection;
  constructor({ store, adapter, ocrAdapter, ocrImageAdapter, inspection }) { this.#store = store; this.#adapter = adapter; this.#ocrAdapter = ocrAdapter; this.#ocrImageAdapter = ocrImageAdapter; this.#inspection = inspection; }

  async analyze(documentId, { language = 'eng', pages = [1], zones = [], cleanupPreset = 'document', segmentation = 'auto', detectTables = true, signal: externalSignal } = {}, lock) {
    if (!this.#ocrAdapter || !this.#ocrImageAdapter) throw new HostError('ENGINE_UNAVAILABLE', 'Local OCR layout analysis requires Tesseract and ImageMagick.', 503);
    validateOcrMode(cleanupPreset, segmentation);
    if (typeof detectTables !== 'boolean') throw new HostError('INVALID_OCR_OPTIONS', 'detectTables must be a boolean.', 400);
    if (!Array.isArray(pages) || !pages.length || pages.length > MAX_OCR_LAYOUT_PAGES || new Set(pages).size !== pages.length || pages.some((value) => !Number.isSafeInteger(value) || value < 1)) throw new HostError('INVALID_OCR_PAGES', `Choose one through ${MAX_OCR_LAYOUT_PAGES} unique positive pages.`, 400);
    if (!Array.isArray(zones) || zones.length > MAX_OCR_LAYOUT_ZONES) throw new HostError('INVALID_OCR_ZONES', `Choose at most ${MAX_OCR_LAYOUT_ZONES} OCR zones.`, 400);
    const selectedPages = new Set(pages); const checkedZones = zones.map((zone) => strictOcrZone(zone, selectedPages));
    if (new Set(checkedZones.map(({ id }) => id)).size !== checkedZones.length) throw new HostError('INVALID_OCR_ZONES', 'OCR zone IDs must be unique.', 400);
    if (checkedZones.some((zone, index) => checkedZones.slice(index + 1).some((other) => ocrZonesOverlap(zone, other)))) throw new HostError('INVALID_OCR_ZONES', 'OCR zones on the same page must not overlap.', 400);
    for (const page of pages) if (checkedZones.filter((zone) => zone.page === page).length > MAX_OCR_ZONES_PER_PAGE) throw new HostError('INVALID_OCR_ZONES', `Choose at most ${MAX_OCR_ZONES_PER_PAGE} zones per page.`, 400);
    const resultingZoneCount = pages.reduce((count, page) => count + Math.max(1, checkedZones.filter((zone) => zone.page === page).length), 0);
    if (resultingZoneCount > MAX_OCR_LAYOUT_ZONES) throw new HostError('INVALID_OCR_ZONES', `OCR analysis is limited to ${MAX_OCR_LAYOUT_ZONES} page regions.`, 400);
    return lock.run(() => withOcrWorkspace({
      store: this.#store, documentId, externalSignal,
      timeoutMessage: 'Local OCR layout analysis exceeded its ten-minute deadline.',
      cancelledMessage: 'The local OCR layout operation was cancelled.',
      work: async ({ deadline, createWorkspace }) => {
        const languages = await ocrLanguages(this.#ocrAdapter, { signal: deadline.signal }); validateOcrLanguage(language, languages);
        const inspection = await this.#inspection.inspect(documentId, { signal: deadline.signal });
        if (pages.some((value) => value > inspection.pageCount)) throw new HostError('INVALID_OCR_PAGES', 'OCR page is outside the document.', 400);
        const source = this.#store.getDocument(documentId); await this.#store.verifySource(documentId);
        const { workspace, quota } = await createWorkspace(); const input = this.#store.getSourcePath(documentId); const records = [];
        for (const currentPage of pages) {
          const pageGeometry = await this.#inspection.inspectPage(documentId, currentPage, { signal: deadline.signal }); const prefix = join(workspace, `layout-${currentPage}`); const image = `${prefix}.png`;
          await this.#adapter.execute('renderPagePng', { input, outputPrefix: prefix, page: currentPage, maxDimension: 3_200 }, { cwd: workspace, signal: deadline.signal, timeoutMs: 45_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024 });
          await validatePngOutput(image, MAX_OCR_RASTER_BYTES, `OCR layout page ${currentPage}`); const dimensions = await pngDimensions(image); const dpi = ocrDpi(dimensions, pageGeometry);
          const pageZones = checkedZones.filter((zone) => zone.page === currentPage); const selected = pageZones.length ? pageZones : [Object.freeze({ id: `page-${currentPage}`, type: 'text', page: currentPage, x: 0, y: 0, width: 1, height: 1 })];
          for (const [zoneIndex, zone] of selected.entries()) {
            const region = Object.freeze({ x: zone.x, y: zone.y, width: zone.width, height: zone.height }); const expectedCrop = cropDimensions(dimensions, region);
            if (expectedCrop.width < 16 || expectedCrop.height < 16) throw new HostError('INVALID_OCR_ZONES', 'OCR zones must cover at least 16 by 16 raster pixels.', 400);
            if (zone.type === 'image' || zone.type === 'exclude') { records.push(Object.freeze({ page: currentPage, pageSize: pageGeometry, zoneId: zone.id, zoneType: zone.type, region, dpi, classificationOnly: true, recognizedWordCount: 0, layout: null, tableCandidates: Object.freeze([]), alto: null })); continue; }
            const crop = join(workspace, `layout-${currentPage}-zone-${zoneIndex + 1}.png`);
            await this.#ocrImageAdapter.execute('crop', { input: image, output: crop, workspace, imageWidth: dimensions.width, imageHeight: dimensions.height, region, dpi, preset: cleanupPreset }, { cwd: workspace, signal: deadline.signal, timeoutMs: 45_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024 });
            await validatePngOutput(crop, MAX_OCR_RASTER_BYTES, `OCR layout zone ${zone.id}`); const cropped = await pngDimensions(crop);
            if (cropped.width !== expectedCrop.width || cropped.height !== expectedCrop.height) throw new HostError('INVALID_ENGINE_OUTPUT', 'OCR zone cleanup changed the expected crop canvas.', 502);
            const outputBase = join(workspace, `layout-ocr-${currentPage}-${zoneIndex + 1}`);
            await this.#ocrAdapter.execute('recognizeLayout', { input: crop, outputBase, language, dpi, segmentation, detectTables }, { cwd: workspace, signal: deadline.signal, timeoutMs: 90_000, maxStdoutBytes: 256 * 1024, maxStderrBytes: 512 * 1024 });
            const tsvPath = `${outputBase}.tsv`; const altoPath = `${outputBase}.xml`; const [tsvBytes, altoBytes] = await Promise.all([readRegularOutput(tsvPath, { maximumBytes: MAX_OCR_TSV_BYTES, label: `OCR layout TSV ${zone.id}` }), readRegularOutput(altoPath, { maximumBytes: MAX_OCR_ALTO_BYTES, label: `OCR ALTO XML ${zone.id}` })]);
            const alto = validateAltoEvidence(altoBytes); const parsed = parseTesseractTsvHierarchy(decodeUtf8(tsvBytes, `OCR layout TSV ${zone.id}`), { imageWidth: cropped.width, imageHeight: cropped.height, zone: region }); const layout = detectTables ? parsed : Object.freeze({ ...parsed, tableCandidates: Object.freeze([]) }); exportOcrLayoutJson(layout);
            records.push(Object.freeze({ page: currentPage, pageSize: pageGeometry, zoneId: zone.id, zoneType: zone.type, region, dpi, classificationOnly: false, recognizedWordCount: layout.words.length, layout, tableCandidates: layout.tableCandidates, alto }));
            await Promise.all([unlink(crop).catch(() => {}), unlink(tsvPath).catch(() => {}), unlink(altoPath).catch(() => {})]); await quota.check();
          }
          await unlink(image).catch(() => {}); await quota.check();
        }
        const result = Object.freeze({ kind: 'ocr-layout-evidence', schemaVersion: 1, sourceDigest: source.sha256, language, cleanupPreset, segmentation, detectTables, records: Object.freeze(records), evidence: Object.freeze({ localOnly: true, sourceBound: true, engines: Object.freeze(['Poppler', 'ImageMagick', 'Tesseract']), tableMethod: detectTables ? 'tesseract-tsv-geometry-heuristic' : null, reviewRequired: detectTables }), limitations: Object.freeze(['Recognized coordinates do not preserve original fonts, semantic reading order, editable Office layout, or authoritative table structure.', 'Every table candidate is a geometry heuristic and requires human review.']) });
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_OCR_LAYOUT_RESULT_BYTES) throw new HostError('OCR_LAYOUT_LIMIT', 'OCR layout result exceeds the local response limit.', 413);
        await this.#store.verifySource(documentId); return result;
      },
    }));
  }
}
