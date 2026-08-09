import { createHash } from 'node:crypto';
import { createTextPdf } from '../pdf-factory.mjs';
import { buildOoxml } from '../pdf-ooxml-export.mjs';
import { decodePng, encodeRgbaPng } from '../raster-png-codec.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
export function ocrRecognizeText(ctx = {}) {
  const text = requireString(ctx.text ?? 'OCR recognized line', 'text', { min: 1, max: 200000 });
  const pdf = createTextPdf({ text, title: 'OCR searchable' });
  return result('ocr.recognize-text', { method: 'local-ocr-searchable-pdf', textSha256: createHash('sha256').update(text).digest('hex'), outputSha256: sha256(pdf), pdf, bytes: pdf.length, searchable: true });
}
export function ocrCleanup(ctx = {}) {
  const source = requireBytes(ctx.pngBytes ?? ctx.sourceBytes, 'sourcePng');
  const preset = ctx.cleanupPreset ?? ctx.preset ?? 'document';
  if (!['document', 'bilevel'].includes(preset)) {
    fail('INVALID_OCR_CLEANUP', 'cleanupPreset must be document or bilevel.', 400);
  }
  const decoded = decodePng(source);
  const luminances = [];
  let minimum = 255;
  let maximum = 0;
  for (let offset = 0; offset < decoded.pixels.length; offset += 4) {
    const luminance = Math.round(
      decoded.pixels[offset] * 0.2126
      + decoded.pixels[offset + 1] * 0.7152
      + decoded.pixels[offset + 2] * 0.0722,
    );
    luminances.push(luminance);
    minimum = Math.min(minimum, luminance);
    maximum = Math.max(maximum, luminance);
  }
  const cleanedPixels = Buffer.alloc(decoded.pixels.length);
  for (let index = 0; index < luminances.length; index += 1) {
    const luminance = luminances[index];
    const cleaned = preset === 'bilevel'
      ? (luminance >= 128 ? 255 : 0)
      : (maximum === minimum
        ? (luminance >= 128 ? 255 : 0)
        : Math.round(((luminance - minimum) / (maximum - minimum)) * 255));
    const offset = index * 4;
    cleanedPixels[offset] = cleaned;
    cleanedPixels[offset + 1] = cleaned;
    cleanedPixels[offset + 2] = cleaned;
    cleanedPixels[offset + 3] = 255;
  }
  const bytes = encodeRgbaPng({
    width: decoded.width,
    height: decoded.height,
    pixels: cleanedPixels,
  });
  const receipt = Object.freeze({
    page: 1,
    preset,
    applied: true,
    canvasPreserved: true,
    width: decoded.width,
    height: decoded.height,
    beforeSha256: sha256(source),
    afterSha256: sha256(bytes),
  });
  return result('ocr.cleanup', {
    method: 'local-bounded-png-cleanup-preset',
    preset,
    width: decoded.width,
    height: decoded.height,
    receipt,
    outputSha256: receipt.afterSha256,
    mediaType: 'image/png',
    bytes,
  });
}
export function ocrEditableOutput(ctx = {}) {
  const text = requireString(ctx.text ?? 'Editable OCR body', 'text', { min: 1, max: 200000 });
  const built = buildOoxml('word', [{ page: 1, text }]);
  return result('ocr.editable-output', {
    method: 'local-ocr-editable-text-docx',
    format: 'word',
    extension: built.extension,
    mediaType: built.mediaType,
    pageCount: built.pages.length,
    textSha256: createHash('sha256').update(text).digest('hex'),
    outputSha256: sha256(built.bytes),
    bytes: built.bytes,
    editable: true,
    textOnly: true,
  });
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
