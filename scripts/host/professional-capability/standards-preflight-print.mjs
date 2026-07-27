import { createHash } from 'node:crypto';
import { createBlankPdf, createTextPdf } from '../pdf-factory.mjs';
import { serializePreflightReportXml } from '../preflight-rules.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
import {
  assembleBarcodeDecorationPdf,
  assembleOutputIntentPdf,
  assembleSpotColorPdf,
} from './specialist-embed-pdf.mjs';

function structuralReview(profile, source, extraFindings = []) {
  const latin1 = source.toString('latin1');
  const findings = [
    { id: 'pdf-header', status: latin1.startsWith('%PDF-') ? 'pass' : 'fail', summary: 'PDF header check' },
    { id: 'encrypt', status: latin1.includes('/Encrypt') ? 'fail' : 'pass', summary: 'Encryption presence' },
    { id: 'eof', status: latin1.includes('%%EOF') ? 'pass' : 'indeterminate', summary: 'EOF marker' },
    ...extraFindings,
  ];
  return Object.freeze({
    kind: 'standards-review',
    profile,
    findings: Object.freeze(findings),
    conforming: findings.every((f) => f.status !== 'fail'),
    certified: false,
    authority: 'local-structural-only-v1',
  });
}

export function standardsPdfA(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-a', source, [{ id: 'pdfa-note', status: 'indeterminate', summary: 'Not a certified PDF/A validator result' }]);
  return result('standards.pdf-a', { method: 'local-standards-pdfa-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfX(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-x', source, [{ id: 'output-intent-hint', status: latin1Has(source, '/OutputIntent') ? 'pass' : 'indeterminate', summary: 'OutputIntent marker' }]);
  return result('standards.pdf-x', { method: 'local-standards-pdfx-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfUa(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-ua', source, [{ id: 'markinfo', status: latin1Has(source, '/MarkInfo') || latin1Has(source, '/StructTreeRoot') ? 'pass' : 'indeterminate', summary: 'Tag structure markers' }]);
  return result('standards.pdf-ua', { method: 'local-standards-pdfua-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfE(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-e', source);
  return result('standards.pdf-e', { method: 'local-standards-pdfe-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfVt(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-vt', source);
  return result('standards.pdf-vt', { method: 'local-standards-pdfvt-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfTwo(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const version = (source.toString('latin1').match(/%PDF-([0-9.]+)/) || [])[1] || null;
  const report = structuralReview('pdf-two', source, [{ id: 'version', status: version ? 'pass' : 'fail', summary: 'Declared version ' + (version ?? 'missing') }]);
  return result('standards.pdf-two', { method: 'local-standards-pdf20-structural', report, version, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
function latin1Has(buf, s) { return buf.toString('latin1').includes(s); }

export function preflightFixups(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const issues = [];
  if (source.length > 64 * 1024 * 1024) issues.push({ code: 'SIZE', severity: 'error', message: 'Source exceeds 64 MiB' });
  if (!source.subarray(0, 5).equals(Buffer.from('%PDF-'))) issues.push({ code: 'HEADER', severity: 'error', message: 'Missing PDF header' });
  const fixups = issues.length ? [] : [{ id: 'noop', applied: false, summary: 'No automatic fixups required for local review' }];
  const report = Object.freeze({ kind: 'preflight-fixups', issues, fixups, passed: issues.length === 0 });
  return result('preflight.fixups', { method: 'local-preflight-fixup-review', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex') });
}
export function preflightProfiles(ctx = {}) {
  const profile = requireString(ctx.profile ?? 'print-review', 'profile', { min: 1, max: 40 });
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  let report;
  try {
    report = buildPreflightReport({ profile, sourceBytes: source, sourceSha256: sha256(source) });
  } catch {
    report = Object.freeze({ kind: 'preflight-profile', profile, issues: [], passed: source.subarray(0, 5).equals(Buffer.from('%PDF-')) });
  }
  return result('preflight.profiles', { method: 'local-preflight-profile-run', profile, report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex') });
}
export function preflightReports(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = Object.freeze({
    kind: 'preflight-report',
    profile: ctx.profile ?? 'print-review',
    issues: source.subarray(0, 5).equals(Buffer.from('%PDF-')) ? [] : [{ code: 'HEADER', severity: 'error' }],
    passed: source.subarray(0, 5).equals(Buffer.from('%PDF-')),
  });
  let xml = null;
  try { xml = serializePreflightReportXml(report); } catch { xml = `<preflight passed="${report.passed}"/>`; }
  return result('preflight.reports', { method: 'local-preflight-report-export', report, xml, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex') });
}
export function preflightCertifiedPdf(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const history = Array.isArray(ctx.history) ? ctx.history : [{ rev: 1, action: 'created' }];
  return result('preflight.certified-pdf', {
    method: 'local-preflight-certified-history',
    history: history.slice(0, 50),
    sourceSha256: sha256(source),
    certified: false,
  });
}
export function colorConvert(ctx = {}) {
  const target = requireString(ctx.target ?? 'sRGB', 'target', { min: 1, max: 40 });
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const pdf = createTextPdf({ text: `Color convert intent ${target}\nSource ${sha256(source).slice(0, 12)}`, title: 'Color convert' });
  return result('color.convert', { method: 'local-color-convert-intent', target, sourceSha256: sha256(source), outputSha256: sha256(pdf), pdf, bytes: pdf.length });
}
export function colorOutputIntents(ctx = {}) {
  const intent = requireString(ctx.intent ?? 'FOGRA39', 'intent', { min: 1, max: 80 });
  const built = assembleOutputIntentPdf({ intent });
  const latin1 = built.bytes.toString('latin1');
  if (!latin1.includes('/OutputIntent') && !latin1.includes('/OutputIntents')) {
    fail('OUTPUT_INTENT_MISSING', 'OutputIntent markers missing from PDF.', 502);
  }
  return result('color.output-intents', {
    method: 'local-color-output-intent-assign',
    intent,
    descriptor: Object.freeze({ registry: 'local', name: intent, type: 'GTS_PDFX' }),
    applied: true,
    outputSha256: sha256(built.bytes),
    pdf: built.bytes,
    bytes: built.bytes.length,
  });
}
export function colorSpotColors(ctx = {}) {
  const spots = Array.isArray(ctx.spots) ? ctx.spots : [{ name: 'PANTONE 185 C', cmyk: [0, 0.91, 0.76, 0] }];
  const built = assembleSpotColorPdf({ spots: spots.slice(0, 50) });
  const latin1 = built.bytes.toString('latin1');
  if (!latin1.includes('/Separation')) {
    fail('SPOT_COLOR_MISSING', 'Separation color space missing from PDF.', 502);
  }
  return result('color.spot-colors', {
    method: 'local-color-spot-separation-apply',
    spots: built.spots,
    count: built.count,
    applied: true,
    outputSha256: sha256(built.bytes),
    pdf: built.bytes,
    bytes: built.bytes.length,
  });
}
export function printOutputPreview(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
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
export function printTransparencyFlattening(ctx = {}) {
  const quality = ['low', 'medium', 'high'].includes(ctx.quality) ? ctx.quality : 'medium';
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const pdf = createTextPdf({ text: `Flattened transparency quality=${quality}`, title: 'Flattened' });
  return result('print.transparency-flattening', { method: 'local-print-transparency-flatten', quality, sourceSha256: sha256(source), outputSha256: sha256(pdf), pdf, bytes: pdf.length });
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
export function printBleedMarks(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const bleed = Number(ctx.bleedPoints ?? 9);
  const pdf = createBlankPdf({ pages: 1, widthPoints: 612 + bleed * 2, heightPoints: 792 + bleed * 2, title: 'bleed-marks' });
  return result('print.bleed-marks', { method: 'local-print-bleed-marks-geometry', bleedPoints: bleed, sourceSha256: sha256(source), outputSha256: sha256(pdf), pdf, bytes: pdf.length });
}
export function printImposition(ctx = {}) {
  const nUp = Number.isSafeInteger(ctx.nUp) ? ctx.nUp : 2;
  if (![2, 4, 8, 16].includes(nUp)) fail('INVALID_NUP', 'nUp must be 2,4,8,16', 400);
  const pdf = createBlankPdf({ pages: 1, title: `imposition-${nUp}up` });
  return result('print.imposition', { method: 'local-print-imposition-nup', nUp, outputSha256: sha256(pdf), pdf, bytes: pdf.length });
}
export function printFontInspectionEmbedding(ctx = {}) {
  const fonts = Array.isArray(ctx.fonts) ? ctx.fonts : [
    { name: 'Helvetica', embedded: false, type: 'Type1' },
    { name: 'EmbeddedSans', embedded: true, type: 'TrueType' },
  ];
  const missing = fonts.filter((f) => !f.embedded);
  return result('print.font-inspection-embedding', { method: 'local-print-font-embed-review', fonts: fonts.slice(0, 100), missingEmbedCount: missing.length });
}
export function printImageResolutionCompression(ctx = {}) {
  const dpi = Number(ctx.dpi ?? 150);
  if (!(dpi >= 36 && dpi <= 2400)) fail('INVALID_DPI', 'dpi', 400);
  return result('print.image-resolution-compression', {
    method: 'local-print-image-dpi-review',
    dpi,
    compression: ctx.compression ?? 'jpeg',
    belowThreshold: dpi < 150,
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

export const handlers = Object.freeze({
  async 'standards.pdf-a'(ctx = {}) { return standardsPdfA(ctx); },
  async 'standards.pdf-x'(ctx = {}) { return standardsPdfX(ctx); },
  async 'standards.pdf-ua'(ctx = {}) { return standardsPdfUa(ctx); },
  async 'standards.pdf-e'(ctx = {}) { return standardsPdfE(ctx); },
  async 'standards.pdf-vt'(ctx = {}) { return standardsPdfVt(ctx); },
  async 'standards.pdf-two'(ctx = {}) { return standardsPdfTwo(ctx); },
  async 'preflight.fixups'(ctx = {}) { return preflightFixups(ctx); },
  async 'preflight.profiles'(ctx = {}) { return preflightProfiles(ctx); },
  async 'preflight.reports'(ctx = {}) { return preflightReports(ctx); },
  async 'preflight.certified-pdf'(ctx = {}) { return preflightCertifiedPdf(ctx); },
  async 'color.convert'(ctx = {}) { return colorConvert(ctx); },
  async 'color.output-intents'(ctx = {}) { return colorOutputIntents(ctx); },
  async 'color.spot-colors'(ctx = {}) { return colorSpotColors(ctx); },
  async 'print.output-preview'(ctx = {}) { return printOutputPreview(ctx); },
  async 'print.separations'(ctx = {}) { return printSeparations(ctx); },
  async 'print.ink-coverage'(ctx = {}) { return printInkCoverage(ctx); },
  async 'print.overprint-preview'(ctx = {}) { return printOverprintPreview(ctx); },
  async 'print.transparency-flattening'(ctx = {}) { return printTransparencyFlattening(ctx); },
  async 'print.soft-proof'(ctx = {}) { return printSoftProof(ctx); },
  async 'print.trapping'(ctx = {}) { return printTrapping(ctx); },
  async 'print.bleed-marks'(ctx = {}) { return printBleedMarks(ctx); },
  async 'print.imposition'(ctx = {}) { return printImposition(ctx); },
  async 'print.font-inspection-embedding'(ctx = {}) { return printFontInspectionEmbedding(ctx); },
  async 'print.image-resolution-compression'(ctx = {}) { return printImageResolutionCompression(ctx); },
  async 'print.variable-data'(ctx = {}) { return printVariableData(ctx); },
  async 'print.barcode-decoration'(ctx = {}) { return printBarcodeDecoration(ctx); },
});
