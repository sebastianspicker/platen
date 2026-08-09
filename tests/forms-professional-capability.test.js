import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { formFixture } from '../scripts/host/professional-capability/fixtures.mjs';
import { handlers } from '../scripts/host/professional-capability/forms.mjs';
import {
  preparePdfAcroFormTextField,
  inspectPdfAcroFormTextField,
  PDF_ACROFORM_TEXT_FIELD_PROFILE,
} from '../scripts/host/pdf-acroform-text-field-writer.mjs';
import {
  preparePdfAcroFormBarcode,
  inspectPdfAcroFormBarcode,
} from '../scripts/host/pdf-acroform-barcode-writer.mjs';
import {
  PDF_ACROFORM_BARCODE_PROFILE,
  PDF_ACROFORM_BARCODE_SYMBOLOGY,
} from '../scripts/host/pdf-acroform-barcode-contract.mjs';
import { makeButtonWidgetPdf } from './host-pdfkit-test-fixtures-b.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('forms mutation subset preserves source prefix and reports partial writer validation', async () => {
  const source = formFixture();
  for (const [id, context] of [
    ['forms.barcode-fields', { value: 'WB-001' }],
    ['forms.signature-fields', { fieldName: 'SignatureField' }],
  ]) {
    const outcome = await handlers[id]({ sourcePdf: source, ...context });
    assert.equal(outcome.ok, true, id);
    assert.equal(outcome.sourceSha256, digest(source), id);
    assert.equal(outcome.sourcePrefixPreserved, true, id);
    assert.equal(outcome.professionalProof, false, id);
    assert.equal(outcome.proofStatus, 'partial', id);
    assert.equal(outcome.validationBoundary.includes('in-process'), true, id);
    assert.ok(Buffer.isBuffer(outcome.pdf), id);
    assert.equal(outcome.pdf.subarray(0, source.length).equals(source), true, id);
    if (id === 'forms.signature-fields') {
      assert.equal(outcome.method, 'local-pdf-acroform-signature-field');
      assert.equal(outcome.signingPerformed, false);
    }
  }
});

test('text and barcode artifact tampering is fail-closed', () => {
  const source = formFixture();
  const textRequest = {
    profile: PDF_ACROFORM_TEXT_FIELD_PROFILE,
    sourceSha256: digest(source),
    page: 1,
    fieldName: 'Account.Name',
    rect: { x: 72, y: 700, width: 180, height: 24 },
  };
  const text = preparePdfAcroFormTextField(source, textRequest);
  const textTampered = Buffer.from(text.bytes);
  textTampered[textTampered.length - 20] ^= 1;
  assert.throws(
    () => inspectPdfAcroFormTextField(source, textTampered, textRequest),
    { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD_OUTPUT' },
  );

  const barcodeRequest = {
    profile: PDF_ACROFORM_BARCODE_PROFILE,
    sourceSha256: digest(source),
    page: 1,
    fieldName: 'BarcodeField',
    rect: { x: 72, y: 640, width: 360, height: 32 },
    symbology: PDF_ACROFORM_BARCODE_SYMBOLOGY,
    payload: 'WB-001',
  };
  const barcode = preparePdfAcroFormBarcode(source, barcodeRequest);
  const barcodeTampered = Buffer.from(barcode.bytes);
  barcodeTampered[barcodeTampered.length - 20] ^= 1;
  assert.throws(
    () => inspectPdfAcroFormBarcode(source, barcodeTampered, barcodeRequest),
    { code: 'INVALID_PDF_ACROFORM_BARCODE_OUTPUT' },
  );
});

test('forms calculation is deterministic and rejects unsafe requests', async () => {
  const calculation = await handlers['forms.calculate']({ a: 9, b: 4, operation: 'subtract' });
  assert.equal(calculation.result, 5);
  assert.equal(calculation.expression, 'a-b');
  assert.equal(Object.hasOwn(calculation, 'sourceSha256'), false);
  assert.equal(calculation.proofStatus, 'partial');
  await assert.rejects(
    () => handlers['forms.calculate']({ demoFixture: true, sourcePdf: formFixture() }),
    (error) => error.code === 'FORM_DEMO_SOURCE_CONFLICT' && error.status === 422,
  );
  await assert.rejects(
    () => handlers['forms.calculate']({ a: 1, b: 0, operation: 'divide' }),
    (error) => error.code === 'FORM_CALCULATE_INVALID_REQUEST' && error.status === 400,
  );
});

test('tab order and tooltip capability requires an exact source-bound widget locator', async () => {
  const source = makeButtonWidgetPdf();
  const sourceSha256 = digest(source);
  const fingerprint = digest(Buffer.from([
    'pdfkit-inspector:opaque-locator:v1',
    `source-sha256=${sourceSha256}`,
    'page=1',
    'annotation-index=0',
    'subtype=widget',
    'widget-type=button',
  ].join('\n'), 'utf8'));
  const request = {
    profile: 'local-pdf-acroform-tab-order-tooltip-v1',
    sourceSha256,
    target: { page: 1, annotationIndex: 0, fingerprint },
    tooltip: 'Consent',
  };
  const outcome = await handlers['forms.tab-order-tooltips']({ sourcePdf: source, formRequest: request });
  assert.equal(outcome.proof.tabOrder, 'S');
  assert.equal(outcome.proof.pageResourcesAnnotationsPreserved, true);
  await assert.rejects(
    () => handlers['forms.tab-order-tooltips']({ sourcePdf: source }),
    (error) => error.code === 'FORM_TAB_REQUEST_REQUIRED' && error.status === 422,
  );
  await assert.rejects(
    () => handlers['forms.barcode-fields']({ sourcePdf: formFixture(), value: 'lowercase' }),
    (error) => error.code === 'FORM_BARCODE_INVALID_REQUEST' && error.status === 400,
  );
  await assert.rejects(
    () => handlers['forms.flatten']({ sourcePdf: formFixture() }),
    (error) => error.code === 'FORM_FLATTEN_UNSUPPORTED' && error.status === 422,
  );
});
