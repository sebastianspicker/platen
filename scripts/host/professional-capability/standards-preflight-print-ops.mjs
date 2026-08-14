import { createHash } from 'node:crypto';
import { createBlankPdf } from '../pdf-factory.mjs';
import { PREFLIGHT_PROFILES, serializePreflightReportXml } from '../preflight-rules.mjs';
import { PDF_PRINTER_MARKS_PROFILE } from '../pdf-printer-marks-writer.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
import { assembleBarcodeDecorationPdf } from './specialist-embed-pdf.mjs';
import {
  SHA256, abort, runtime, authority, retainedBytes, revokeAfterFailure, boundDocument, strictReport,
} from './standards-preflight-print-core.mjs';

export function preflightFixups(ctx = {}) {
  const source = requireBytes(ctx.sourcePdf, 'sourcePdf');
  const issues = [];
  if (source.length > 64 * 1024 * 1024) issues.push({ code: 'SIZE', severity: 'error', message: 'Source exceeds 64 MiB' });
  if (!source.subarray(0, 5).equals(Buffer.from('%PDF-'))) issues.push({ code: 'HEADER', severity: 'error', message: 'Missing PDF header' });
  const fixups = issues.length ? [] : [{ id: 'noop', applied: false, summary: 'No automatic fixups required for local review' }];
  const report = Object.freeze({ kind: 'preflight-fixups', issues, fixups, passed: issues.length === 0 });
  return result('preflight.fixups', { method: 'local-preflight-fixup-review', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex') });
}
export function preflightProfiles(ctx = {}) {
  const profile = requireString(ctx.profile ?? 'print-review', 'profile', { min: 1, max: 40 });
  if (!PREFLIGHT_PROFILES.includes(profile)) fail('INVALID_PREFLIGHT_PROFILE', 'Choose print-review or archive-review.', 400);
  const prepress = authority(ctx, 'prepress', 'PrepressService');
  if (typeof prepress.runPreflight === 'function') {
    boundDocument(ctx, 'preflight source');
    return Promise.resolve(prepress.runPreflight(ctx.documentId, { profile, signal: ctx.signal })).then((report) => {
      const valid = strictReport(report, profile);
      if (valid.document.sha256 !== ctx.sourceSha256) fail('PREFLIGHT_OUTPUT_INVALID', 'Preflight service returned a report for a different source.', 502);
      return result('preflight.profiles', {
        method: 'validated-local-preflight-service', profile, sourceSha256: ctx.sourceSha256,
        report: valid, reportSha256: valid.reportSha256, authoritative: false, certified: false,
        limitations: ['The retained local preflight report is non-authoritative review evidence, not standards certification or press approval.'],
      });
    });
  }
  fail('PREFLIGHT_UNAVAILABLE', 'The production preflight service is unavailable for fixed-profile preflight.', 503);
}
export async function preflightReports(ctx = {}) {
  const profile = requireString(ctx.profile ?? 'print-review', 'profile', { min: 1, max: 40 });
  const generated = await preflightProfiles(ctx).then((value) => value.report);
  const report = strictReport(generated, profile);
  const xml = serializePreflightReportXml(report);
  return result('preflight.reports', {
    method: 'validated-preflight-report-export', profile, report, xml, reportSha256: report.reportSha256,
    formats: ['json', 'xml'], authoritative: false, certified: false,
    limitations: ['The exported local preflight report is non-authoritative review evidence, not standards certification or press approval.'],
  });
}
export function preflightCertifiedPdf(ctx = {}) {
  const source = requireBytes(ctx.sourcePdf, 'sourcePdf');
  const history = Array.isArray(ctx.history) ? ctx.history : [{ rev: 1, action: 'created' }];
  return result('preflight.certified-pdf', {
    method: 'local-preflight-certified-history',
    history: history.slice(0, 50),
    sourceSha256: sha256(source),
    certified: false,
  });
}

export function printOutputPreview(ctx = {}) {
  const source = requireBytes(ctx.sourcePdf, 'sourcePdf');
  return result('print.output-preview', {
    method: 'local-print-output-preview-token',
    sourceSha256: sha256(source),
    previewId: createHash('sha256').update(source.subarray(0, 64)).digest('hex').slice(0, 16),
    profile: ctx.profile ?? 'screen-preview',
  });
}
export function printSeparations(ctx = {}) {
  const plates = Array.isArray(ctx.plates) ? ctx.plates : ['Cyan', 'Magenta', 'Yellow', 'Black'];
  return result('print.separations', { method: 'local-print-separation-plates', plates: plates.slice(0, 16), count: plates.length });
}
export function printInkCoverage(ctx = {}) {
  const coverage = {
    C: Number(ctx.C ?? 12),
    M: Number(ctx.M ?? 8),
    Y: Number(ctx.Y ?? 10),
    K: Number(ctx.K ?? 20),
  };
  const total = coverage.C + coverage.M + coverage.Y + coverage.K;
  return result('print.ink-coverage', { method: 'local-print-ink-coverage-estimate', coverage, total, overLimit: total > 300 });
}
export function printOverprintPreview(ctx = {}) {
  return result('print.overprint-preview', {
    method: 'local-print-overprint-flags',
    overprintFill: ctx.overprintFill !== false,
    overprintStroke: Boolean(ctx.overprintStroke),
    simulate: true,
  });
}
export async function printTransparencyFlattening(ctx = {}) {
  if (ctx.quality !== undefined && ctx.quality !== 'medium') {
    fail('UNSUPPORTED_TRANSPARENCY_QUALITY', 'The validated Ghostscript rewrite has one fixed flattening profile.', 422);
  }
  const conversion = authority(ctx, 'conversion', 'ConversionService');
  const source = boundDocument(ctx, 'transparency source');
  let document;
  try {
    document = await conversion.rewriteDocument(ctx.documentId, 'flatten-transparency', { signal: ctx.signal });
    const input = document?.operation?.inputs?.find((entry) => entry?.role === 'primary');
    const validators = document?.operation?.validation?.validators;
    const valid = document && typeof document.id === 'string'
      && SHA256.test(document.sha256 ?? '') && Number.isSafeInteger(document.size) && document.size > 0
      && document.operation?.type === 'flatten-transparency'
      && document.operation?.validation?.passed === true
      && Array.isArray(validators) && validators.includes('source-sha256') && validators.includes('pdfinfo-page-count')
      && Number.isSafeInteger(document.operation.validation.pageCount) && document.operation.validation.pageCount > 0
      && input?.documentId === source.id && input?.sha256 === source.sha256;
    if (!valid) fail('TRANSPARENCY_FLATTENING_OUTPUT_INVALID', 'Validated transparency rewrite returned an incoherent provenance receipt.', 502);
    abort(ctx.signal);
    const reread = await retainedBytes(runtime(ctx).store, 'document', document.id, document.sha256, 'TRANSPARENCY_FLATTENING_ARTIFACT_REVOKED', document.size);
    reread.fill(0);
  } catch (error) {
    if (document?.id && document.id !== ctx.documentId) return revokeAfterFailure(runtime(ctx).store, 'document', document.id, error);
    throw error;
  }
  return result('print.transparency-flattening', {
    method: 'validated-ghostscript-transparency-flatten-service',
    profile: 'fixed-ghostscript-flatten-transparency',
    sourceSha256: ctx.sourceSha256,
    outputDocumentId: document.id,
    outputSha256: document.sha256,
    size: document.size,
    pageCount: document.operation.validation.pageCount,
    operationType: document.operation.type,
    compatibilityLevel: '1.3',
    flatteningVerified: false,
    authoritative: false,
    certified: false,
    limitations: ['The fixed local Ghostscript PDF 1.3 rewrite preserves source provenance and page count but does not prove that every transparency construct was flattened or certify standards or press suitability.'],
  });
}
export function printSoftProof(ctx = {}) {
  const profile = requireString(ctx.profile ?? 'sRGB', 'profile', { min: 1, max: 80 });
  return result('print.soft-proof', { method: 'local-print-soft-proof-profile', profile, intent: ctx.intent ?? 'relative-colorimetric' });
}
export function printTrapping(ctx = {}) {
  const width = Number(ctx.widthPoints ?? 0.25);
  if (!(width >= 0 && width <= 4)) fail('INVALID_TRAP', 'width', 400);
  return result('print.trapping', { method: 'local-print-trap-width', widthPoints: width, enabled: width > 0 });
}
export async function printBleedMarks(ctx = {}) {
  const service = authority(ctx, 'printerMarks', 'PdfPrinterMarksService');
  const source = boundDocument(ctx, 'printer-marks source');
  const bleed = Number(ctx.bleedPoints ?? 9);
  if (!Number.isFinite(bleed) || bleed < 4 || bleed > 72) fail('INVALID_BLEED', 'bleedPoints must be from 4 through 72.', 400);
  const pages = Array.isArray(ctx.markPages) ? ctx.markPages : [1];
  const request = { profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: source.sha256, pages };
  let output;
  try {
    output = await service.create(ctx.documentId, request, { sourceSha256: source.sha256, signal: ctx.signal });
    if (!output || output.kind !== 'pdf-printer-marks' || output.sourceDigest !== source.sha256 || output.evidence?.localOnly !== true || !Array.isArray(output.limitations) || output.limitations.length < 1 || !output.artifact || !SHA256.test(output.artifact.sha256 ?? '')) fail('PRINTER_MARKS_OUTPUT_INVALID', 'Printer-marks service returned an incoherent artifact receipt.', 502);
    abort(ctx.signal);
    const pdf = await retainedBytes(runtime(ctx).store, 'artifact', output.artifact.id, output.artifact.sha256, 'PRINTER_MARKS_ARTIFACT_REVOKED');
    for (const page of output.pages ?? []) {
      const margins = [page.trimBox?.[0] - page.bleedBox?.[0], page.trimBox?.[1] - page.bleedBox?.[1], page.bleedBox?.[2] - page.trimBox?.[2], page.bleedBox?.[3] - page.trimBox?.[3]];
      if (margins.some((margin) => !Number.isFinite(margin) || Math.abs(margin - bleed) > 0.0001)) fail('BLEED_GEOMETRY_MISMATCH', 'bleedPoints must match every selected page BleedBox-to-TrimBox margin.', 422);
    }
    return result('print.bleed-marks', {
      method: 'validated-pdf-printer-marks-service', profile: PDF_PRINTER_MARKS_PROFILE, bleedPoints: bleed,
      sourceSha256: source.sha256, artifactId: output.artifact.id, outputSha256: output.artifact.sha256, pdf, byteLength: pdf.length,
      proof: { pages: output.pages, sourcePrefixPreserved: output.evidence.sourceUnchanged, outputDigestBound: output.evidence.outputDigestBound },
      cropMarksApplied: true, colorBarsApplied: false, registrationMarksApplied: false,
      authoritative: false, certified: false, limitations: output.limitations,
    });
  } catch (error) {
    if (output?.artifact?.id) return revokeAfterFailure(runtime(ctx).store, 'artifact', output.artifact.id, error);
    throw error;
  }
}
export async function printImposition(ctx = {}) {
  const nUp = Number.isSafeInteger(ctx.nUp) ? ctx.nUp : 2;
  if (![2, 4].includes(nUp)) fail('INVALID_NUP', 'nUp must be 2 or 4.', 400);
  const layout = ctx.layout ?? (nUp === 2 ? '2x1' : '2x2');
  if ((layout === '2x1' ? 2 : layout === '2x2' ? 4 : 0) !== nUp) {
    fail('INVALID_IMPOSITION_LAYOUT', 'layout must match the requested nUp value.', 400);
  }
  if (ctx.marks === true) {
    fail('PRINTER_MARKS_UNSUPPORTED', 'Validated Ghostscript imposition does not include printer marks.', 422);
  }
  const prepress = authority(ctx, 'prepress', 'PrepressService');
  const source = boundDocument(ctx, 'imposition source');
  let imposed;
  try {
    imposed = await prepress.createImposition(ctx.documentId, { layout, marks: false, signal: ctx.signal });
    const validators = imposed?.receipt?.validators ?? imposed?.artifact?.operation?.validation?.validators;
    const provenance = imposed?.artifact?.operation;
    const valid = imposed?.kind === 'imposition-artifact'
      && imposed.sourceDigest === source.sha256
      && imposed.artifact && typeof imposed.artifact.id === 'string' && SHA256.test(imposed.artifact.sha256 ?? '')
      && imposed.layout?.id === layout && imposed.layout?.across * imposed.layout?.down === nUp
      && imposed.layout?.marks === 'none' && imposed.receipt?.engine?.name === 'Ghostscript'
      && imposed.receipt?.pageCount === imposed.layout?.sheetCount
      && imposed.receipt?.textExtractionEquivalent === true && imposed.receipt?.everySheetRendered === true
      && imposed.receipt?.pdfXValidated === false && imposed.authoritative === false
      && Array.isArray(imposed.limitations) && imposed.limitations.length > 0
      && Array.isArray(validators) && validators.includes('source-sha256') && validators.includes('artifact-sha256')
      && provenance?.type === 'ghostscript-nup-imposition'
      && provenance?.validation?.passed === true && provenance.validation.outputSha256 === imposed.artifact.sha256
      && provenance.inputs?.some((input) => input.documentId === source.id && input.sha256 === source.sha256);
    if (!valid) fail('IMPOSITION_OUTPUT_INVALID', 'Validated imposition service returned an incoherent Ghostscript provenance receipt.', 502);
    abort(ctx.signal);
    const reread = await retainedBytes(runtime(ctx).store, 'artifact', imposed.artifact.id, imposed.artifact.sha256, 'IMPOSITION_ARTIFACT_REVOKED');
    reread.fill(0);
  } catch (error) {
    if (imposed?.artifact?.id) return revokeAfterFailure(runtime(ctx).store, 'artifact', imposed.artifact.id, error);
    throw error;
  }
  return result('print.imposition', {
    method: 'validated-ghostscript-imposition-service',
    nUp,
    artifactId: imposed.artifact.id,
    sourceDigest: imposed.sourceDigest,
    layout: imposed.layout,
    receipt: imposed.receipt,
    authoritative: imposed.authoritative,
    limitations: imposed.limitations,
  });
}
export async function printFontInspectionEmbedding(ctx = {}) {
  const pdf = authority(ctx, 'pdf', 'PdfInspectionService');
  const source = boundDocument(ctx, 'font inspection source');
  const fonts = await pdf.listFonts(source.id, { signal: ctx.signal });
  if (!Array.isArray(fonts)) fail('FONT_INSPECTION_OUTPUT_INVALID', 'Font inspection service returned no inventory.', 502);
  const missing = fonts.filter((f) => f?.embedded !== true && String(f?.embedded).toLowerCase() !== 'yes');
  const returnedFonts = fonts.slice(0, 100);
  return result('print.font-inspection-embedding', {
    method: 'validated-local-font-inventory', sourceSha256: source.sha256,
    fonts: returnedFonts, fontCount: fonts.length, returnedFontCount: returnedFonts.length,
    truncated: fonts.length > returnedFonts.length, missingEmbedCount: missing.length,
    inspected: true, authoritative: false, certified: false,
    limitations: ['Embedding and subsetting are reported from local inspection evidence; no press certification or outline conversion is performed.'],
  });
}
export async function printImageResolutionCompression(ctx = {}) {
  const pdf = authority(ctx, 'pdf', 'PdfInspectionService');
  const source = boundDocument(ctx, 'image inspection source');
  const images = await pdf.listImages(source.id, { signal: ctx.signal });
  if (!Array.isArray(images)) fail('IMAGE_INSPECTION_OUTPUT_INVALID', 'Image inspection service returned no inventory.', 502);
  const returnedImages = images.slice(0, 100);
  const usableResolution = (image) => Number.isFinite(image?.xPpi) && image.xPpi > 0
    && Number.isFinite(image?.yPpi) && image.yPpi > 0;
  const belowThresholdCount = images.filter((image) => usableResolution(image)
    && Math.min(image.xPpi, image.yPpi) < 150).length;
  const unknownResolutionCount = images.filter((image) => !usableResolution(image)).length;
  return result('print.image-resolution-compression', {
    method: 'validated-local-image-inventory', sourceSha256: source.sha256,
    images: returnedImages, imageCount: images.length, returnedImageCount: returnedImages.length,
    truncated: images.length > returnedImages.length, dpiThreshold: 150,
    belowThreshold: belowThresholdCount > 0, belowThresholdCount, unknownResolutionCount,
    inspected: true, compressionControlled: false, authoritative: false, certified: false,
    limitations: ['Resolution is a bounded review threshold; no recompression or press suitability claim is made.'],
  });
}
export function printVariableData(ctx = {}) {
  const records = Array.isArray(ctx.records) ? ctx.records.slice(0, 100) : [{ name: 'Ada' }, { name: 'Grace' }];
  return result('print.variable-data', { method: 'local-print-variable-data-records', records, count: records.length });
}
export function printBarcodeDecoration(ctx = {}) {
  const value = requireString(ctx.value ?? '123456789012', 'value', { min: 4, max: 64 });
  const symbology = requireString(ctx.symbology ?? 'code128', 'symbology', { min: 2, max: 32 });
  const built = assembleBarcodeDecorationPdf({ value, symbology });
  const latin1 = built.bytes.toString('latin1');
  if (!latin1.includes('BARCODE_ID:') || !latin1.includes('CUT_CONTOUR')) {
    fail('BARCODE_DECORATION_MISSING', 'Barcode decoration markers missing from PDF.', 502);
  }
  return result('print.barcode-decoration', {
    method: 'local-print-barcode-decoration-pdf',
    value: built.value,
    symbology: built.symbology,
    barcodeId: built.barcodeId,
    applied: true,
    outputSha256: sha256(built.bytes),
    pdf: built.bytes,
    bytes: built.bytes.length,
  });
}
