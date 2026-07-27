import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtempSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readZipEntries } from '../scripts/host/zip-reader.mjs';
import { OcrEditableOutputService, receiptFromOcrLayout } from '../scripts/host/ocr-editable-output.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { TesseractAdapter } from '../scripts/host/adapters/tesseract.mjs';
import { OcrImageAdapter } from '../scripts/host/adapters/ocr-image.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const source = { id: '12121212-1212-4121-8121-121212121212', sha256: 'a'.repeat(64), displayName: 'scan.pdf' };
const receipt = Object.freeze({
  schema: 'ocr-editable-text-receipt-v1', version: 1, sourceDigest: source.sha256, language: 'eng',
  engine: Object.freeze({ name: 'Tesseract', version: '5.3.0' }), pageCount: 2,
  pages: Object.freeze([{ page: 1, text: 'First OCR line\nsecond line' }, { page: 2, text: 'last page' }]),
});

function fixture(receiptValue = receipt) {
  const root = mkdtempSync(join(tmpdir(), 'pdf-ocr-editable-output-')); const calls = []; let lastBytes;
  const store = {
    getDocument: () => source, verifySource: async () => calls.push('verify'), createJobWorkspace: async () => root,
    cleanupJob: async () => calls.push('cleanup'),
    promoteOoxmlArtifact: async (_documentId, outputPath, options) => {
      const bytes = readFileSync(outputPath); lastBytes = bytes; calls.push('promote');
      return { id: '22222222-2222-4222-8222-222222222222', documentId: source.id, displayName: 'scan.docx', mediaType: options.mediaType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), operation: options.operation, filePath: outputPath };
    },
  };
  const service = new OcrEditableOutputService({ store, ocr: { inspect: async () => ({ pageCount: 2 }), extractReceipt: async () => receiptValue } });
  return { service, calls, get bytes() { return lastBytes; } };
}

test('OCR editable output creates deterministic source-bound text-only DOCX with OCR provenance', async () => {
  const first = fixture(); const second = fixture();
  const left = await first.service.export(source.id, { sourceSha256: source.sha256 });
  const right = await second.service.export(source.id, { sourceSha256: source.sha256 });
  assert.equal(left.kind, 'ocr-editable-output'); assert.equal(left.language, 'eng'); assert.equal(left.engine.version, '5.3.0');
  assert.equal(left.artifact.operation.type, 'ocr-editable-output');
  assert.equal(left.artifact.operation.parameters.language, 'eng');
  assert.equal(left.artifact.operation.parameters.engine.version, '5.3.0');
  assert.match(left.artifact.operation.parameters.receiptSha256, /^[a-f0-9]{64}$/u);
  assert.equal(left.artifact.operation.validation.outputSha256, left.artifact.sha256);
  assert.deepEqual(first.calls, ['verify', 'verify', 'promote', 'verify', 'cleanup']);
  assert.deepEqual([...readZipEntries(first.bytes).values()].map((value) => value.toString('utf8')).filter((value) => value.includes('First OCR line')).length, 1);
  assert.equal(left.artifact.sha256, right.artifact.sha256);
});

test('OCR editable output rejects untrusted or source-mismatched receipts', async () => {
  const options = { sourceSha256: source.sha256 }; Object.defineProperty(options, 'signal', { enumerable: true, get: () => undefined });
  await assert.rejects(fixture().service.export(source.id, options), { name: 'TypeError' });
  for (const bad of [
    { ...receipt, sourceDigest: 'b'.repeat(64) },
    { ...receipt, language: 'deu' },
    { ...receipt, engine: { name: 'Other', version: '1.0.0' } },
    { ...receipt, engine: { name: 'Tesseract', version: 'not-a-version' } },
    { ...receipt, pages: [{ page: 1, text: 'one' }] },
  ]) {
    await assert.rejects(fixture(bad).service.export(source.id, { sourceSha256: source.sha256 }), { code: 'OCR_EDITABLE_RECEIPT_INVALID' });
  }
  const accessor = { ...receipt }; Object.defineProperty(accessor, 'sourceDigest', { enumerable: true, get: () => source.sha256 });
  await assert.rejects(fixture(accessor).service.export(source.id, { sourceSha256: source.sha256 }), { code: 'OCR_EDITABLE_RECEIPT_INVALID' });
});

test('OCR layout conversion preserves page and line order and rejects empty OCR', () => {
  const converted = receiptFromOcrLayout({ kind: 'ocr-layout-evidence', sourceDigest: source.sha256, language: 'eng', records: [
    { page: 1, layout: { words: [{ line: 2, text: 'two', bounds: { x: 0.2 } }, { line: 1, text: 'one', bounds: { x: 0.4 } }, { line: 1, text: 'first', bounds: { x: 0.1 } }] } },
  ] }, { engineVersion: '5.3.0' });
  assert.equal(converted.pages[0].text, 'first one\ntwo');
  assert.throws(() => receiptFromOcrLayout({ kind: 'ocr-layout-evidence', sourceDigest: source.sha256, language: 'eng', records: [{ page: 1, layout: { words: [] } }] }, { engineVersion: '5.3.0' }), { code: 'OCR_NO_TEXT' });
});

test('document store retains the dedicated OCR editable provenance on the promoted artifact', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-ocr-editable-store-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('STORE OCR')]), displayName: 'store.pdf' });
  const onePage = Object.freeze({ ...receipt, sourceDigest: document.sha256, pageCount: 1, pages: Object.freeze([{ page: 1, text: 'STORE OCR' }]) });
  const editable = new OcrEditableOutputService({ store, ocr: { inspect: async () => ({ pageCount: 1 }), extractReceipt: async () => onePage } });
  const result = await editable.export(document.id, { sourceSha256: document.sha256 });
  const stored = store.getArtifact(result.artifact.id);
  assert.equal(stored.operation.type, 'ocr-editable-output');
  assert.equal(stored.operation.parameters.language, 'eng');
  assert.equal(stored.operation.parameters.engine.name, 'Tesseract');
  assert.match(stored.operation.parameters.receiptSha256, /^[a-f0-9]{64}$/u);
  await store.deleteArtifact(stored.id);
});

test('installed OCR engines can feed editable DOCX, or report explicit unavailability', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/tesseract', '/opt/homebrew/bin/magick'].map((path) => access(path)));
  } catch {
    context.skip('The fixed Poppler, Tesseract, and ImageMagick OCR toolchain is unavailable.');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'pdf-ocr-editable-installed-'));
  const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  const registry = new EngineRegistry(); const adapter = new PopplerAdapter({ registry });
  const service = new PdfService({ store, registry, adapter, ocrAdapter: new TesseractAdapter({ registry }), ocrImageAdapter: new OcrImageAdapter({ registry }) });
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('EDITABLE OCR FIXTURE')]), displayName: 'fixture.pdf' });
  const editable = new OcrEditableOutputService({ store, ocr: {
    inspect: service.inspect.bind(service),
    extractReceipt: async (documentId, pageCount, { signal }) => {
      const layout = await service.analyzeOcrLayout(documentId, { language: 'eng', pages: Array.from({ length: pageCount }, (_, index) => index + 1), cleanupPreset: 'none', segmentation: 'auto', detectTables: false, signal });
      return receiptFromOcrLayout(layout, { engineVersion: (await registry.probe('tesseract')).version });
    },
  } });
  const result = await editable.export(document.id, { sourceSha256: document.sha256 });
  assert.equal(result.artifact.operation.type, 'ocr-editable-output');
  await store.deleteArtifact(result.artifact.id);
});
