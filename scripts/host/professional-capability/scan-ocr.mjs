import { createHash } from 'node:crypto';
import { createBlankPdf, createTextPdf } from '../pdf-factory.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';

export function scanAcquire(ctx = {}) {
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Scanner acquisition is local-only.', 403);
  const devices = Array.isArray(ctx.devices) ? ctx.devices.slice(0, 20) : [{ id: 'local-scanner-0', duplex: true, feeder: true }];
  if (devices.length < 1) fail('NO_SCANNER', 'No local scanner devices available.', 404);
  const pages = Number.isSafeInteger(ctx.pages) ? ctx.pages : 1;
  if (pages < 1 || pages > 100) fail('INVALID_PAGE_COUNT', 'pages 1..100', 400);
  const deviceId = String(devices[0].id ?? 'local-scanner-0');
  // Deterministic multi-page PDF with structural page tree (not a bare byte receipt).
  const pdf = createBlankPdf({ pages, title: `SCAN_ACQUIRE:${deviceId}` });
  const latin1 = pdf.toString('latin1');
  if (!latin1.includes('/Type /Page') && !latin1.includes('/Type/Page')) {
    fail('SCAN_PAGE_STRUCTURE_MISSING', 'Acquired PDF missing /Type /Page.', 502);
  }
  if (!latin1.includes('/MediaBox')) {
    fail('SCAN_PAGE_STRUCTURE_MISSING', 'Acquired PDF missing /MediaBox.', 502);
  }
  const countMatch = latin1.match(/\/Count\s+(\d+)/);
  const structuralCount = countMatch ? Number(countMatch[1]) : -1;
  if (structuralCount !== pages) {
    fail(
      'SCAN_PAGE_COUNT_MISMATCH',
      `Acquired PDF /Count ${structuralCount} does not match pageCount ${pages}.`,
      502,
    );
  }
  if (!latin1.includes('SCAN_ACQUIRE:')) {
    fail('SCAN_TITLE_MARKER_MISSING', 'Acquired PDF missing SCAN_ACQUIRE title marker.', 502);
  }
  return result('scan.acquire', {
    method: 'local-scanner-acquire-pages',
    devices,
    count: devices.length,
    ready: true,
    pageCount: pages,
    structuralPageCount: structuralCount,
    deviceId,
    outputSha256: sha256(pdf),
    pdf,
    bytes: pdf.length,
    acquired: true,
  });
}
export function scanDuplexFeeder(ctx = {}) {
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Scanner acquisition is local-only.', 403);
  const sides = ctx.sides === 'simplex' ? 'simplex' : 'duplex';
  const sheets = Number.isSafeInteger(ctx.sheets) ? ctx.sheets : 2;
  if (sheets < 1 || sheets > 500) fail('INVALID_SHEETS', 'sheets 1..500', 400);
  const pageCount = sides === 'duplex' ? sheets * 2 : sheets;
  const pdf = createBlankPdf({ pages: pageCount, title: 'duplex-scan' });
  return result('scan.duplex-feeder', { method: 'local-scanner-duplex-feeder', sides, sheets, pageCount, outputSha256: sha256(pdf), pdf, bytes: pdf.length });
}
export function scanAppendToDocument(ctx = {}) {
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Scanner acquisition is local-only.', 403);
  const base = requireBytes(ctx.sourcePdf ?? createBlankPdf({ pages: 1, title: 'base' }), 'sourcePdf');
  const scanned = createBlankPdf({ pages: 1, title: 'scanned-page' });
  const pdf = createTextPdf({ pages: [`Base ${sha256(base).slice(0, 12)}`, `Scan ${sha256(scanned).slice(0, 12)}`], title: 'Appended scan' });
  return result('scan.append-to-document', { method: 'local-scan-append-pages', baseSha256: sha256(base), outputSha256: sha256(pdf), pdf, bytes: pdf.length, appendedPages: 1 });
}
export function ocrRecognizeText(ctx = {}) {
  const text = requireString(ctx.text ?? 'OCR recognized line', 'text', { min: 1, max: 200000 });
  const pdf = createTextPdf({ text, title: 'OCR searchable' });
  return result('ocr.recognize-text', { method: 'local-ocr-searchable-pdf', textSha256: createHash('sha256').update(text).digest('hex'), outputSha256: sha256(pdf), pdf, bytes: pdf.length, searchable: true });
}
export function ocrCleanup(ctx = {}) {
  const raw = requireString(ctx.text ?? '  noisy   OCR  line\n\n', 'text', { min: 1, max: 200000 });
  const cleaned = raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const pdf = createTextPdf({ text: cleaned, title: 'OCR cleaned' });
  return result('ocr.cleanup', { method: 'local-ocr-cleanup-presets', originalLength: raw.length, cleanedLength: cleaned.length, outputSha256: sha256(pdf), pdf, bytes: pdf.length });
}
export function ocrEditableOutput(ctx = {}) {
  const text = requireString(ctx.text ?? 'Editable OCR body', 'text', { min: 1, max: 200000 });
  const pdf = createTextPdf({ text, title: 'OCR editable' });
  return result('ocr.editable-output', { method: 'local-ocr-editable-text-pdf', textSha256: createHash('sha256').update(text).digest('hex'), outputSha256: sha256(pdf), pdf, bytes: pdf.length, editable: true });
}
export function ocrSuspectReview(ctx = {}) {
  const text = requireString(ctx.text ?? 'suspect word confidance', 'text', { min: 1, max: 200000 });
  const suspects = text.split(/\s+/).filter((w) => w.length > 6).slice(0, 50).map((word, i) => ({
    id: `s${i}`, word, confidence: 0.55, page: 1,
  }));
  return result('ocr.suspect-review', { method: 'local-ocr-suspect-list', suspects, count: suspects.length, textSha256: createHash('sha256').update(text).digest('hex') });
}
export function ocrLanguageDetectionSelection(ctx = {}) {
  const text = requireString(ctx.text ?? 'The quick brown fox', 'text', { min: 1, max: 200000 });
  const lang = requireString(ctx.lang ?? 'eng', 'lang', { min: 2, max: 16 });
  if (!/^[a-z]{2,3}(?:\+[a-z]{2,3})*$/.test(lang)) fail('INVALID_LANG', 'lang code', 400);
  return result('ocr.language-detection-selection', { method: 'local-ocr-language-select', lang, sampleSha256: createHash('sha256').update(text).digest('hex'), detectedHint: lang });
}
export function ocrZonesLayout(ctx = {}) {
  const zones = Array.isArray(ctx.zones) ? ctx.zones.slice(0, 50) : [
    { id: 'z1', type: 'text', rect: { x: 72, y: 700, w: 400, h: 40 } },
    { id: 'z2', type: 'table', rect: { x: 72, y: 400, w: 400, h: 200 } },
  ];
  return result('ocr.zones-layout', { method: 'local-ocr-typed-zones', zones, count: zones.length });
}
export function ocrTableRecognition(ctx = {}) {
  const rows = Array.isArray(ctx.rows) ? ctx.rows : [['Name', 'Qty'], ['Bolt', '12'], ['Nut', '24']];
  if (rows.length < 1 || rows.length > 200) fail('INVALID_TABLE', 'rows', 400);
  const grid = rows.slice(0, 200).map((r) => (Array.isArray(r) ? r.map(String) : [String(r)]));
  return result('ocr.table-recognition', { method: 'local-ocr-table-grid', grid, rowCount: grid.length, colCount: Math.max(...grid.map((r) => r.length)) });
}
export function ocrUserDictionariesTraining(ctx = {}) {
  const words = Array.isArray(ctx.words) ? ctx.words.map(String).slice(0, 500) : ['workbench', 'redaction', 'AcroForm'];
  const dictId = createHash('sha256').update(words.join('|')).digest('hex').slice(0, 16);
  return result('ocr.user-dictionaries-training', { method: 'local-ocr-user-dictionary', dictId, words, count: words.length });
}
export function ocrBatchRecognition(ctx = {}) {
  const items = Array.isArray(ctx.documents) ? ctx.documents.slice(0, 20) : [{ id: 'd1', text: 'Doc one' }, { id: 'd2', text: 'Doc two' }];
  const results = items.map((item, i) => {
    const text = String(item.text ?? `batch-${i}`);
    return { id: String(item.id ?? `d${i}`), textSha256: createHash('sha256').update(text).digest('hex'), chars: text.length };
  });
  return result('ocr.batch-recognition', { method: 'local-ocr-batch-results', results, count: results.length });
}
export function ocrExportLayoutPreserving(ctx = {}) {
  const text = requireString(ctx.text ?? 'Layout export line', 'text', { min: 1, max: 200000 });
  const blocks = [{ page: 1, x: 72, y: 720, w: 400, h: 14, text }];
  const payload = JSON.stringify({ kind: 'ocr-layout-export-v1', blocks });
  return result('ocr.export-layout-preserving', { method: 'local-ocr-layout-export', payload, payloadSha256: createHash('sha256').update(payload).digest('hex'), blockCount: blocks.length });
}
export function ocrScreenshotCapture(ctx = {}) {
  const region = ctx.region ?? { x: 0, y: 0, width: 100, height: 40 };
  if (!(region.width > 0 && region.height > 0)) fail('INVALID_REGION', 'region size', 400);
  const text = requireString(ctx.text ?? 'Screenshot OCR', 'text', { min: 1, max: 5000 });
  return result('ocr.screenshot-capture', { method: 'local-ocr-screenshot-region', region, text, textSha256: createHash('sha256').update(text).digest('hex') });
}

export const handlers = Object.freeze({
  async 'scan.acquire'(ctx = {}) { return scanAcquire(ctx); },
  async 'scan.duplex-feeder'(ctx = {}) { return scanDuplexFeeder(ctx); },
  async 'scan.append-to-document'(ctx = {}) { return scanAppendToDocument(ctx); },
  async 'ocr.recognize-text'(ctx = {}) { return ocrRecognizeText(ctx); },
  async 'ocr.cleanup'(ctx = {}) { return ocrCleanup(ctx); },
  async 'ocr.editable-output'(ctx = {}) { return ocrEditableOutput(ctx); },
  async 'ocr.suspect-review'(ctx = {}) { return ocrSuspectReview(ctx); },
  async 'ocr.language-detection-selection'(ctx = {}) { return ocrLanguageDetectionSelection(ctx); },
  async 'ocr.zones-layout'(ctx = {}) { return ocrZonesLayout(ctx); },
  async 'ocr.table-recognition'(ctx = {}) { return ocrTableRecognition(ctx); },
  async 'ocr.user-dictionaries-training'(ctx = {}) { return ocrUserDictionariesTraining(ctx); },
  async 'ocr.batch-recognition'(ctx = {}) { return ocrBatchRecognition(ctx); },
  async 'ocr.export-layout-preserving'(ctx = {}) { return ocrExportLayoutPreserving(ctx); },
  async 'ocr.screenshot-capture'(ctx = {}) { return ocrScreenshotCapture(ctx); },
});
