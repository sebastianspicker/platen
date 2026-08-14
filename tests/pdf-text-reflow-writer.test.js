import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePdfTextReflowRequest } from '../scripts/host/pdf-text-reflow-contract.mjs';
import { inspectPdfTextReflow, writePdfTextReflow } from '../scripts/host/pdf-text-reflow-writer.mjs';
import { makeTextReflowPdf, textReflowRequest } from './host-pdf-text-reflow-fixtures.mjs';

test('fixed-slot text reflow deterministically wraps one source-bound paragraph', () => {
  const source = makeTextReflowPdf(); const request = textReflowRequest(source); const first = writePdfTextReflow(source, request); const second = writePdfTextReflow(source, request);
  assert.deepEqual(first.bytes, second.bytes); assert.equal(first.bytes.subarray(0, source.length).equals(source), true); assert.equal(first.proof.lineCount, 3); assert.equal(first.proof.lineWidth, 20); assert.equal(first.proof.streamByteLengthPreserved, true); assert.match(first.bytes.subarray(source.length).toString('latin1'), /\(Alpha beta gamma    \) Tj/u); assert.match(first.bytes.subarray(source.length).toString('latin1'), /\(delta epsilon       \) Tj/u); assert.deepEqual(inspectPdfTextReflow(source, first.bytes, request), first.proof);
});

test('text reflow rejects stale locators, hostile descriptors, overflow, active content, and output drift', () => {
  const source = makeTextReflowPdf(); const request = textReflowRequest(source);
  assert.throws(() => writePdfTextReflow(source, { ...request, originalTextSha256: '0'.repeat(64) }), { code: 'UNSUPPORTED_PDF_TEXT_REFLOW' }); assert.throws(() => writePdfTextReflow(source, { ...request, lineTokenIndices: [7, 11, 13] }), { code: 'UNSUPPORTED_PDF_TEXT_REFLOW' }); assert.throws(() => writePdfTextReflow(source, { ...request, replacementText: 'A'.repeat(21) }), { code: 'UNSUPPORTED_PDF_TEXT_REFLOW' });
  const getter = { ...request }; Object.defineProperty(getter, 'page', { enumerable: true, get() { throw new Error('getter'); } }); assert.throws(() => normalizePdfTextReflowRequest(getter), { code: 'INVALID_PDF_TEXT_REFLOW' }); const proxy = new Proxy(request.lineTokenIndices, {}); assert.throws(() => normalizePdfTextReflowRequest({ ...request, lineTokenIndices: proxy }), { code: 'INVALID_PDF_TEXT_REFLOW' });
  const active = makeTextReflowPdf({ catalogExtra: ' /OpenAction 5 0 R' }); assert.throws(() => writePdfTextReflow(active, textReflowRequest(active)), { code: 'UNSUPPORTED_PDF_TEXT_REFLOW' }); const arrayText = makeTextReflowPdf({ streamOverride: 'BT\n/F1 12 Tf\n[(Alpha beta)] TJ\nET\n' }); assert.throws(() => writePdfTextReflow(arrayText, textReflowRequest(arrayText)), { code: 'UNSUPPORTED_PDF_TEXT_REFLOW' });
  const aliased = makeTextReflowPdf({ catalogExtra: ' /Alias 4 0 R' }); assert.throws(() => writePdfTextReflow(aliased, textReflowRequest(aliased)), { code: 'UNSUPPORTED_PDF_TEXT_REFLOW' });
  const unbalanced = makeTextReflowPdf({ streamOverride: '(Alpha beta          ) Tj\nT*\n(gamma delta         ) Tj\nT*\n(                    ) Tj\n' }); assert.throws(() => writePdfTextReflow(unbalanced, textReflowRequest(unbalanced, { lineTokenIndices: [0, 3, 6] })), { code: 'UNSUPPORTED_PDF_TEXT_REFLOW' });
  const built = writePdfTextReflow(source, request); assert.throws(() => inspectPdfTextReflow(source, Buffer.concat([built.bytes, Buffer.from('tamper')]), request), { code: 'INVALID_PDF_TEXT_REFLOW_OUTPUT' });
});
