import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { makeButtonWidgetPdf } from './host-pdfkit-test-fixtures-b.js';
import { PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE, normalizePdfAccessibilityFormSemantics } from '../scripts/host/pdf-accessibility-form-semantics-contract.mjs';
import { inspectPdfAccessibilityFormSemantics, writePdfAccessibilityFormSemantics } from '../scripts/host/pdf-accessibility-form-semantics-writer.mjs';
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(source, fields = [0, 1, 2]) {
  const sourceSha256 = digest(source);
  return {
    profile: PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE, sourceSha256,
    fields: fields.map((annotationIndex, tabIndex) => ({
      target: { page: 1, annotationIndex, fingerprint: digest(Buffer.from([
        'pdfkit-inspector:opaque-locator:v1', `source-sha256=${sourceSha256}`,
        'page=1', `annotation-index=${annotationIndex}`, 'subtype=widget',
        'widget-type=button',
      ].join('\n'))) },
      role: 'button', name: `Control ${annotationIndex + 1}`,
      tooltip: `Accessible control ${annotationIndex + 1}`, tabIndex,
    })),
  };
}
test('accessible form semantics writes names, tooltips, and deterministic tab order without changing source bytes', () => {
  const source = makeButtonWidgetPdf(); const value = request(source, [2, 0, 1]);
  const built = writePdfAccessibilityFormSemantics(source, value);
  assert.equal(built.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(built.proof.fieldCount, 3);
  assert.deepEqual(built.proof.orderedWidgetObjects.map((entry) => entry.object), [8, 6, 7]);
  assert.deepEqual(inspectPdfAccessibilityFormSemantics(source, built.bytes, value), built.proof);
});
test('accessible form semantics rejects stale locators, forged roles, accessors, active content, and output drift', () => {
  const source = makeButtonWidgetPdf(); const value = request(source);
  assert.throws(() => writePdfAccessibilityFormSemantics(source, { ...value, sourceSha256: '0'.repeat(64) }), { code: 'INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS' });
  assert.throws(() => writePdfAccessibilityFormSemantics(source, { ...value, fields: value.fields.map((field) => ({ ...field, role: 'text' })) }), { code: 'INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS' });
  const getter = { ...value }; Object.defineProperty(getter, 'sourceSha256', { enumerable: true, get() { throw new Error('getter'); } });
  assert.throws(() => normalizePdfAccessibilityFormSemantics(getter), { code: 'INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS' });
  const fieldsProxy = new Proxy(value.fields, {});
  assert.throws(() => normalizePdfAccessibilityFormSemantics({ ...value, fields: fieldsProxy }), { code: 'INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS' });
  const active = Buffer.from(source.toString('latin1').replace('/AcroForm 9 0 R', '/AcroForm 9 0 R /OpenAction 9 0 R'), 'latin1');
  assert.throws(() => writePdfAccessibilityFormSemantics(active, request(active)), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_FORM_SEMANTICS' });
  const duplicateField = Buffer.from(source.toString('latin1').replace('/Fields [6 0 R 7 0 R 8 0 R]', '/Fields [6 0 R 7 0 R 6 0 R]'), 'latin1');
  assert.throws(() => writePdfAccessibilityFormSemantics(duplicateField, request(duplicateField)), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_FORM_SEMANTICS' });
  const built = writePdfAccessibilityFormSemantics(source, value);
  assert.throws(() => inspectPdfAccessibilityFormSemantics(source, Buffer.concat([built.bytes, Buffer.from('tamper')]), value), { code: 'INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS_OUTPUT' });
});
