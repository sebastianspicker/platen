import assert from 'node:assert/strict';
import test from 'node:test';
import { OCR_LIMITS, normalizeOcrBatchRequest, normalizeOcrDocumentRequest, normalizeOcrLayoutRequest, validateInstalledOcrLanguage, validateOcrLayoutResult } from '../src/core/ocr-contract.js';

const languages = ['eng', 'deu', 'osd'];
const zone = { id: 'zone-1', type: 'text', page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.2 };

test('OCR layout normalizer returns strict deeply immutable local options', () => {
  const actual = normalizeOcrLayoutRequest({ language: 'eng+deu', pages: [1, 2], zones: [zone], cleanupPreset: 'bilevel', segmentation: 'block', detectTables: false }, languages);
  assert.deepEqual(actual, { language: 'eng+deu', pages: [1, 2], zones: [zone], cleanupPreset: 'bilevel', segmentation: 'block', detectTables: false });
  assert.equal(Object.isFrozen(actual), true); assert.equal(Object.isFrozen(actual.pages), true); assert.equal(Object.isFrozen(actual.zones[0]), true);
  assert.throws(() => { actual.zones[0].x = 0.9; }, TypeError);
});

test('OCR contract rejects unsafe installed-language input and exact-key escapes', () => {
  for (const value of ['eng;', 'eng+eng', 'ENG', 'eng+fra', 'eng\u0000']) assert.throws(() => validateInstalledOcrLanguage(value, languages), { code: 'OCR_CONTRACT_INVALID' });
  assert.throws(() => normalizeOcrLayoutRequest({ pages: [1], zones: [], surprise: true }, languages), { code: 'OCR_CONTRACT_INVALID' });
  assert.throws(() => normalizeOcrLayoutRequest({ detectTables: 'yes' }, languages), { code: 'OCR_CONTRACT_INVALID' });
});

test('OCR user dictionary normalizes only safe bounded terms for host-side materialization', () => {
  const actual = normalizeOcrDocumentRequest({ userDictionary: ['  caf\u00e9  ', 'and/or'] }, languages);
  assert.deepEqual(actual.userDictionary, ['caf\u00e9', 'and/or']);
  assert.equal(Object.isFrozen(actual.userDictionary), true);
  for (const dictionary of [
    ['same', 'same'], ['line\nbreak'], ['\u2060hidden'], ['\ud800'], ['/private/words'], ['~/words'], ['./words'], ['../words'], ['C:\\words'], ['\\\\server\\words'],
    Array.from({ length: OCR_LIMITS.maxUserDictionaryTerms + 1 }, (_, index) => `term-${index}`),
  ]) assert.throws(() => normalizeOcrDocumentRequest({ userDictionary: dictionary }, languages), { code: 'OCR_CONTRACT_INVALID' });
});

test('OCR zones reject duplicates, overlaps, and raster-too-small rectangles', () => {
  assert.throws(() => normalizeOcrLayoutRequest({ zones: [zone, { ...zone, x: 0.5 }] }, languages), { code: 'OCR_CONTRACT_INVALID' });
  assert.throws(() => normalizeOcrLayoutRequest({ zones: [zone, { ...zone, id: 'zone-2', x: 0.2 }] }, languages), { code: 'OCR_CONTRACT_INVALID' });
  assert.throws(() => normalizeOcrLayoutRequest({ zones: [{ ...zone, width: OCR_LIMITS.minNormalizedZoneSize / 2 }] }, languages), { code: 'OCR_CONTRACT_INVALID' });
});

test('OCR batch normalizer enforces IDs 1 through 8 and bounded request count', () => {
  const actual = normalizeOcrBatchRequest({ requests: [{ id: 1, documentId: 'doc-1', kind: 'document', options: {} }, { id: 2, documentId: 'doc_2', kind: 'document', options: { cleanupPreset: 'none' } }] }, languages);
  assert.equal(Object.isFrozen(actual.requests[0].options), true);
  assert.throws(() => normalizeOcrBatchRequest({ requests: [{ id: 0, documentId: 'doc', kind: 'document', options: {} }] }, languages), { code: 'OCR_CONTRACT_INVALID' });
  assert.throws(() => normalizeOcrBatchRequest({ requests: [{ id: 1, documentId: 'doc', kind: 'layout', options: { zones: [] } }] }, languages), { code: 'OCR_CONTRACT_INVALID' });
  assert.throws(() => normalizeOcrBatchRequest({ requests: Array.from({ length: 9 }, (_, index) => ({ id: index + 1, documentId: 'doc', kind: 'document', options: {} })) }, languages), { code: 'OCR_CONTRACT_INVALID' });
});

test('OCR result validator accepts only exact local source-bound versioned keys', () => {
  const evidence = { localOnly: true, sourceBound: true, engines: ['Poppler', 'ImageMagick', 'Tesseract'], tableMethod: 'tesseract-tsv-geometry-heuristic', reviewRequired: true };
  const payload = {
    kind: 'ocr-layout-evidence', schemaVersion: 1, sourceDigest: 'a'.repeat(64), language: 'eng', cleanupPreset: 'document', segmentation: 'auto', detectTables: true,
    records: [{ page: 1, pageSize: { page: 1, widthPoints: 612, heightPoints: 792 }, zoneId: 'image-1', zoneType: 'image', region: { x: 0, y: 0, width: 1, height: 1 }, dpi: 300, classificationOnly: true, recognizedWordCount: 0, layout: null, tableCandidates: [], alto: null }],
    evidence, limitations: ['Geometry requires review.'],
  };
  const result = validateOcrLayoutResult(payload);
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.throws(() => validateOcrLayoutResult({ ...payload, extra: true }), { code: 'OCR_CONTRACT_INVALID' });
});
