import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePdfXfaPresence, inspectPdfXfaPresenceAnalysis } from '../scripts/host/pdf-xfa-inspection-analyzer.mjs';
import { makeXfaInspectionPdf, xfaInspectionRequest } from './host-pdf-xfa-inspection-fixtures.mjs';

test('XFA inspection reports only key presence without dereferencing XFA payloads', () => {
  for (const source of [makeXfaInspectionPdf({ catalogXfa: true }), makeXfaInspectionPdf({ acroFormXfa: true })]) {
    const report = analyzePdfXfaPresence(source, xfaInspectionRequest(source));
    assert.equal(report.xfaPresent, true);
    assert.equal(report.inspection, 'catalog-and-direct-acroform-key-presence-only');
    assert.doesNotMatch(JSON.stringify(report), /payload|5 0 R|\/XFA/u);
    assert.deepEqual(inspectPdfXfaPresenceAnalysis(source, xfaInspectionRequest(source), report), report);
  }
});

test('XFA inspection returns false for absent keys and ignores comment and stream decoys', () => {
  const source = makeXfaInspectionPdf({ content: 'BT\n(/XFA stream-decoy) Tj\nET\n' });
  const report = analyzePdfXfaPresence(source, xfaInspectionRequest(source));
  assert.equal(report.xfaPresent, false);
  assert.equal(report.sourceSha256, xfaInspectionRequest(source).sourceSha256);
});

test('XFA inspection treats every direct XFA value as presence without reporting its data', () => {
  const source = makeXfaInspectionPdf({ catalogXfa: true, xfaValue: '(private template payload)' });
  const report = analyzePdfXfaPresence(source, xfaInspectionRequest(source));
  assert.equal(report.xfaPresent, true);
  assert.doesNotMatch(JSON.stringify(report), /private template payload/u);
});

test('XFA inspection rejects indirect AcroForms, malformed and non-classic sources', () => {
  const indirect = makeXfaInspectionPdf({ acroFormXfa: true, indirectAcroForm: true });
  assert.throws(() => analyzePdfXfaPresence(indirect, xfaInspectionRequest(indirect)), { code: 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE' });
  const malformed = Buffer.from(makeXfaInspectionPdf().toString('latin1').replace('/Root 1 0 R', '/Root 99 0 R'), 'latin1');
  assert.throws(() => analyzePdfXfaPresence(malformed, xfaInspectionRequest(malformed)), { code: 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE' });
  const malformedAcroForm = Buffer.from(makeXfaInspectionPdf().toString('latin1').replace('/AcroForm << /Fields [] >>', '/AcroForm []'), 'latin1');
  assert.throws(() => analyzePdfXfaPresence(malformedAcroForm, xfaInspectionRequest(malformedAcroForm)), { code: 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE' });
  const encrypted = Buffer.from(makeXfaInspectionPdf().toString('latin1').replace('/Root 1 0 R >>', '/Root 1 0 R /Encrypt 5 0 R >>'), 'latin1');
  assert.throws(() => analyzePdfXfaPresence(encrypted, xfaInspectionRequest(encrypted)), { code: 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE' });
  assert.throws(() => analyzePdfXfaPresence(Buffer.from('not-a-pdf'), xfaInspectionRequest(Buffer.from('not-a-pdf'))), { code: 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE' });
});

test('XFA inspection rejects stale, accessor, proxy, and forged report inputs', () => {
  const source = makeXfaInspectionPdf({ catalogXfa: true });
  const request = xfaInspectionRequest(source);
  assert.throws(() => analyzePdfXfaPresence(source, { ...request, sourceSha256: '0'.repeat(64) }), { code: 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE' });
  const getter = xfaInspectionRequest(source);
  Object.defineProperty(getter, 'profile', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => analyzePdfXfaPresence(source, getter), { code: 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE' });
  assert.throws(() => analyzePdfXfaPresence(source, new Proxy(request, {})), { code: 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE' });
  const report = analyzePdfXfaPresence(source, request);
  assert.throws(() => inspectPdfXfaPresenceAnalysis(source, request, { ...report, xfaPresent: false }), { code: 'INVALID_PDF_XFA_INSPECTION_OUTPUT' });
});
