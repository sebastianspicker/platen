import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { analyzePdfFormJavaScript, inspectPdfFormJavaScriptAnalysis } from '../scripts/host/pdf-form-javascript-analyzer.mjs';
import { formJavaScriptRequest, makeFormJavaScriptPdf } from './host-pdf-form-javascript-fixtures.mjs';

test('form JavaScript analyzer reports bounded action loci without raw script text', () => {
  const script = 'event.rc = true;'; const source = makeFormJavaScriptPdf({ actions: [{ trigger: 'K', script }, { trigger: 'V', script: 'event.value !== "";' }] }); const request = formJavaScriptRequest(source); const report = analyzePdfFormJavaScript(source, request);
  assert.equal(report.actionCount, 2); assert.equal(report.totalScriptBytes, Buffer.byteLength(script) + Buffer.byteLength('event.value !== "";')); assert.deepEqual(report.actionLoci.map(({ trigger }) => trigger), ['keystroke', 'validate']); assert.equal(report.rawScriptTextIncluded, false); assert.equal(report.activeContentExecuted, false); assert.equal(JSON.stringify(report).includes(script), false); assert.match(report.actionLoci[0].scriptSha256, /^[0-9a-f]{64}$/u); assert.deepEqual(inspectPdfFormJavaScriptAnalysis(source, request, report), report);
});

test('form JavaScript analyzer returns a deterministic empty review for a passive form and ignores comment/string decoys', () => {
  const content = '% /S /JavaScript /JS (comment hidden)\nBT\n(/S /JavaScript /JS \(string hidden\)) Tj\nET\n'; const source = makeFormJavaScriptPdf({ actions: [], content }); const request = formJavaScriptRequest(source); const first = analyzePdfFormJavaScript(source, request); const second = analyzePdfFormJavaScript(source, request);
  assert.deepEqual(first, second); assert.equal(first.actionCount, 0); assert.equal(first.totalScriptBytes, 0); assert.deepEqual(first.actionLoci, []); assert.equal(JSON.stringify(first).includes('comment hidden'), false);
});

test('form JavaScript analyzer rejects indirect, chained, shared, unreachable, signed, encrypted, and unsupported actions', () => {
  const cases = [
    makeFormJavaScriptPdf({ indirectScript: true }),
    makeFormJavaScriptPdf({ actionExtra: ' /Next 8 0 R', extraObjects: [[8, '<< /S /JavaScript /JS <31> >>']] }),
    makeFormJavaScriptPdf({ actions: [{ trigger: 'K', script: 'one' }, { trigger: 'V', script: 'two' }], sharedAction: true }),
    makeFormJavaScriptPdf({ actions: [], extraObjects: [[7, '<< /S /JavaScript /JS <68696464656E> >>']] }),
    makeFormJavaScriptPdf({ catalogExtra: ' /Perms 7 0 R', extraObjects: [[7, '<< /Type /Sig /ByteRange [0 1 2 3] >>']] }),
    makeFormJavaScriptPdf({ catalogExtra: ' /OpenAction 7 0 R' }),
  ];
  for (const source of cases) assert.throws(() => analyzePdfFormJavaScript(source, formJavaScriptRequest(source)), { code: 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE' });
  const encrypted = Buffer.from(makeFormJavaScriptPdf().toString('latin1').replace('/Root 1 0 R >>', '/Root 1 0 R /Encrypt 9 0 R >>'), 'latin1'); assert.throws(() => analyzePdfFormJavaScript(encrypted, formJavaScriptRequest(encrypted)), { code: 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE' });
});

test('form JavaScript analyzer rejects one merged widget listed by two pages', () => {
  const source = makeFormJavaScriptPdf({ duplicateWidgetOnSecondPage: true });
  assert.throws(() => analyzePdfFormJavaScript(source, formJavaScriptRequest(source)), { code: 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE' });
});

test('form JavaScript analyzer rejects hierarchical or duplicate root partial field names', () => {
  const dotted = makeFormJavaScriptPdf({ fieldName: 'Order.Code' });
  assert.throws(() => analyzePdfFormJavaScript(dotted, formJavaScriptRequest(dotted)), { code: 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE' });
  const duplicate = makeFormJavaScriptPdf({ duplicateRootFieldName: true });
  assert.throws(() => analyzePdfFormJavaScript(duplicate, formJavaScriptRequest(duplicate)), { code: 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE' });
});

test('form JavaScript analyzer rejects stale, accessor, proxy, and forged report values', () => {
  const source = makeFormJavaScriptPdf(); const request = formJavaScriptRequest(source); assert.throws(() => analyzePdfFormJavaScript(source, { ...request, sourceSha256: '0'.repeat(64) }), { code: 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE' });
  const getter = formJavaScriptRequest(source); Object.defineProperty(getter, 'profile', { enumerable: true, get() { throw new Error('must not run'); } }); assert.throws(() => analyzePdfFormJavaScript(source, getter), { code: 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE' }); assert.throws(() => analyzePdfFormJavaScript(source, new Proxy(request, {})), { code: 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE' });
  const report = analyzePdfFormJavaScript(source, request); assert.throws(() => inspectPdfFormJavaScriptAnalysis(source, request, { ...report, actionCount: 0 }), { code: 'INVALID_PDF_FORM_JAVASCRIPT_INVENTORY_OUTPUT' }); const rawDigest = createHash('sha256').update('event.rc = true;').digest('hex'); assert.equal(report.actionLoci[0].scriptSha256, rawDigest);
});
