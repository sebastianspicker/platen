import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { makeButtonWidgetPdf, makeCanonicalRadioPdf } from './host-pdfkit-test-fixtures-b.js';
import {
  inspectPdfAcroFormTabOrderTooltip,
  preparePdfAcroFormTabOrderTooltip,
} from '../scripts/host/pdf-acroform-tab-order-tooltip-writer.mjs';
import { PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE, normalizePdfAcroFormTabOrderTooltip } from '../scripts/host/pdf-acroform-tab-order-tooltip-contract.mjs';

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(source, page = 1, annotationIndex = 0, fieldType = 'button', tooltip = 'Accessible name') {
  const sourceSha256 = digest(source);
  const fingerprint = digest(Buffer.from([
    'pdfkit-inspector:opaque-locator:v1', `source-sha256=${sourceSha256}`, `page=${page}`,
    `annotation-index=${annotationIndex}`, 'subtype=widget', `widget-type=${fieldType}`,
  ].join('\n')));
  return { profile: PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE, sourceSha256, target: { page, annotationIndex, fingerprint }, tooltip };
}

test('tab-order and tooltip writer updates only the requested widget and page', () => {
  const source = makeButtonWidgetPdf(); const value = request(source);
  const prepared = preparePdfAcroFormTabOrderTooltip(source, value);
  assert.equal(prepared.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(prepared.proof.tabOrder, 'S');
  assert.equal(prepared.proof.changedObjectCount, 2);
  assert.match(prepared.bytes.toString('latin1'), /\/TU <FEFF00410063006300650073007300690062006C00650020006E0061006D0065>/u);
  assert.deepEqual(inspectPdfAcroFormTabOrderTooltip(source, prepared.bytes, value), prepared.proof);
});

test('tab-order and tooltip writer resolves inherited field type but rejects stale locators and unsafe sources', () => {
  const source = makeCanonicalRadioPdf(); const value = request(source);
  assert.equal(preparePdfAcroFormTabOrderTooltip(source, value).proof.fieldType, 'button');
  assert.throws(() => preparePdfAcroFormTabOrderTooltip(source, { ...value, target: { ...value.target, fingerprint: '0'.repeat(64) } }), { code: 'INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP' });
  const active = Buffer.from(makeButtonWidgetPdf().toString('latin1').replace('/AcroForm 9 0 R', '/AcroForm 9 0 R /OpenAction 9 0 R'), 'latin1');
  assert.throws(() => preparePdfAcroFormTabOrderTooltip(active, request(active)), { code: 'UNSUPPORTED_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE' });
});

test('tab-order and tooltip contract rejects accessors, symbols, and unbounded text', () => {
  const source = makeButtonWidgetPdf(); const value = request(source);
  const accessor = { ...value }; Object.defineProperty(accessor, 'tooltip', { get() { return 'bad'; }, enumerable: true });
  assert.throws(() => normalizePdfAcroFormTabOrderTooltip(accessor), { code: 'INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP' });
  assert.throws(() => normalizePdfAcroFormTabOrderTooltip({ ...value, tooltip: 'x'.repeat(128) }), { code: 'INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP' });
  assert.throws(() => normalizePdfAcroFormTabOrderTooltip({ ...value, [Symbol('mutation')]: true }), { code: 'INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP' });
});
