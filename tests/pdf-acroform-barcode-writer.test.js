import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPdfAcroFormBarcode, writePdfAcroFormBarcode } from '../scripts/host/pdf-acroform-barcode-writer.mjs';
import { barcodeFieldRequest, makeBarcodeFieldPdf } from './host-pdf-acroform-barcode-fixtures.mjs';

test('barcode writer emits one deterministic passive read-only Code 39 widget', () => {
  const source = makeBarcodeFieldPdf(); const request = barcodeFieldRequest(source); const first = writePdfAcroFormBarcode(source, request); const second = writePdfAcroFormBarcode(source, request);
  assert.deepEqual(first.bytes, second.bytes); assert.equal(first.proof.readOnly, true); assert.equal(first.proof.activeContentAdded, false); assert.equal(first.proof.addedObjectCount, 3); assert.equal(first.proof.changedObjectCount, 5); assert.ok(first.proof.moduleCount > 100); assert.ok(first.bytes.includes(Buffer.from(' re f\n', 'latin1')));
  const proof = inspectPdfAcroFormBarcode(source, first.bytes, request); assert.equal(proof.otherPagesContentResourcesPreserved, true); assert.deepEqual(proof.references, first.proof.references);
});

test('barcode writer binds payload to both stored value and vector appearance', () => {
  const source = makeBarcodeFieldPdf(); const first = writePdfAcroFormBarcode(source, barcodeFieldRequest(source)); const second = writePdfAcroFormBarcode(source, barcodeFieldRequest(source, { payload: 'XYZ 789' }));
  assert.notEqual(first.proof.payloadSha256, second.proof.payloadSha256); assert.notDeepEqual(first.bytes, second.bytes); assert.equal(first.proof.symbology, 'code39-basic'); assert.equal(first.proof.quietZoneModules, 10);
});

test('barcode writer rejects request descriptor drift, invalid payloads, stale sources, and geometry', () => {
  const source = makeBarcodeFieldPdf();
  assert.throws(() => writePdfAcroFormBarcode(source, barcodeFieldRequest(source, { payload: 'lowercase' })), { code: 'INVALID_PDF_ACROFORM_BARCODE' });
  assert.throws(() => writePdfAcroFormBarcode(source, barcodeFieldRequest(source, { payload: 'ABC*123' })), { code: 'INVALID_PDF_ACROFORM_BARCODE' });
  assert.throws(() => writePdfAcroFormBarcode(source, barcodeFieldRequest(source, { sourceSha256: '0'.repeat(64) })), { code: 'INVALID_PDF_ACROFORM_BARCODE' });
  assert.throws(() => writePdfAcroFormBarcode(source, barcodeFieldRequest(source, { fieldName: 'Shipping.Barcode' })), { code: 'INVALID_PDF_ACROFORM_BARCODE' });
  assert.throws(() => writePdfAcroFormBarcode(source, barcodeFieldRequest(source, { rect: { x: 500, y: 700, width: 240, height: 48 } })), { code: 'INVALID_PDF_ACROFORM_BARCODE' });
  const getter = barcodeFieldRequest(source); Object.defineProperty(getter.rect, 'x', { enumerable: true, get() { throw new Error('getter must not run'); } }); assert.throws(() => writePdfAcroFormBarcode(source, getter), { code: 'INVALID_PDF_ACROFORM_BARCODE' });
  assert.throws(() => writePdfAcroFormBarcode(source, new Proxy(barcodeFieldRequest(source), {})), { code: 'INVALID_PDF_ACROFORM_BARCODE' });
});

test('barcode writer rejects active or pre-existing forms and detects output tampering', () => {
  for (const options of [{ catalogExtra: ' /OpenAction 7 0 R' }, { catalogExtra: ' /AcroForm 7 0 R' }, { pageExtra: ' /Annots [7 0 R]' }, { catalogExtra: ' /StructTreeRoot 7 0 R' }, { catalogExtra: ' /OCProperties 7 0 R' }]) { const source = makeBarcodeFieldPdf(options); assert.throws(() => writePdfAcroFormBarcode(source, barcodeFieldRequest(source)), { code: 'UNSUPPORTED_PDF_ACROFORM_BARCODE_SOURCE' }); }
  const encrypted = makeBarcodeFieldPdf({ trailerExtra: ' /Encrypt 7 0 R' }); assert.throws(() => writePdfAcroFormBarcode(encrypted, barcodeFieldRequest(encrypted)), { code: 'UNSUPPORTED_PDF_ACROFORM_BARCODE_SOURCE' });
  const source = makeBarcodeFieldPdf(); const request = barcodeFieldRequest(source); const built = writePdfAcroFormBarcode(source, request); const tampered = Buffer.from(built.bytes); tampered[tampered.length - 20] ^= 1; assert.throws(() => inspectPdfAcroFormBarcode(source, tampered, request), { code: 'INVALID_PDF_ACROFORM_BARCODE_OUTPUT' });
});
