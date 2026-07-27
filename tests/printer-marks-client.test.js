import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { PDF_PRINTER_MARKS_LIMITATIONS, PDF_PRINTER_MARKS_PROFILE, PDF_PRINTER_MARKS_VALIDATORS } from '../src/core/pdf-printer-marks-contract.js';

const token = 'a'.repeat(64); const documentId = '11111111-1111-4111-8111-111111111111'; const sourceSha256 = 'b'.repeat(64); const outputSha256 = 'c'.repeat(64);
function result() {
  const proofLines = [[9, 775, 17, 775], [17, 775, 17, 783], [595, 775, 603, 775], [595, 775, 595, 783], [9, 17, 17, 17], [17, 9, 17, 17], [595, 17, 603, 17], [595, 9, 595, 17]];
  const operation = { schemaVersion: 1, id: '22222222-2222-4222-8222-222222222222', type: 'pdf-printer-marks', inputs: [{ documentId, sha256: sourceSha256, role: 'source' }], parameters: { profile: PDF_PRINTER_MARKS_PROFILE, pages: [{ page: 1, bleedBox: [0, 0, 612, 792], trimBox: [18, 18, 594, 774], lines: proofLines }] }, expected: { sourcePrefixPreserved: true, outputSha256 }, validation: { passed: true, validators: PDF_PRINTER_MARKS_VALIDATORS, outputSha256 }, completedAt: '2026-07-20T00:00:00.000Z' };
  const page = {
    page: 1,
    reference: '4 0 R',
    mediaBox: [0, 0, 612, 792],
    cropBox: [0, 0, 612, 792],
    bleedBox: [0, 0, 612, 792],
    trimBox: [18, 18, 594, 774],
    operatorBytes: 1,
    operatorSha256: 'd'.repeat(64),
    lines: proofLines,
    foundationEdit: {
      index: 0,
      page: 1,
      position: 'append',
      reference: '6 0 R',
      objectNumber: 6,
      generation: 0,
      bytes: 1,
      sha256: 'd'.repeat(64),
      tokenCount: 66,
      operatorCounts: { g: 1, G: 1, J: 1, l: 8, m: 8, q: 1, Q: 1, S: 8, w: 1 },
    },
  };
  return { kind: 'pdf-printer-marks', sourceDigest: sourceSha256, artifact: { id: '33333333-3333-4333-8333-333333333333', documentId, displayName: 'printer-marks.pdf', mediaType: 'application/pdf', size: 128, sha256: outputSha256, operation, createdAt: '2026-07-20T00:00:00.000Z' }, pages: [page], evidence: { sourcePrefixPreserved: true, outputDigestBound: true, sourceUnchanged: true, localOnly: true }, limitations: PDF_PRINTER_MARKS_LIMITATIONS };
}

test('local host client posts and validates printer marks', async () => {
  const calls = []; const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 }); return new Response(JSON.stringify({ result: result() }), { status: 201 }); } });
  await client.bootstrap(); const value = await client.createPrinterMarks(documentId, sourceSha256, { pages: [1] });
  assert.equal(value.kind, 'pdf-printer-marks'); assert.equal(calls[1].path, `/api/documents/${documentId}/printer-marks`); assert.deepEqual(JSON.parse(calls[1].options.body), { profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256, pages: [1] });
  assert.throws(() => client.createPrinterMarks(documentId, sourceSha256, { pages: [2, 1] }), TypeError);
});

test('local host client rejects tampered nested printer proofs', async () => {
  const tamperCases = [
    ['reference', (page) => { page.reference = 'hostile'; }],
    ['geometry', (page) => { page.mediaBox = [0, 0, 1, 1]; }],
    ['operator bytes', (page) => { page.operatorBytes = 0; }],
    ['operator digest', (page) => { page.operatorSha256 = 'D'.repeat(64); }],
    ['line geometry', (page) => { page.lines[0] = [20, 20, 30, 30]; }],
    ['foundation linkage', (page) => { page.foundationEdit.bytes = 2; }],
    ['foundation index', (page) => { page.foundationEdit.index = 1; }],
    ['foundation reference', (page) => { page.foundationEdit.reference = '7 0 R'; }],
    ['operator count', (page) => { page.foundationEdit.operatorCounts.S = 7; }],
    ['operator count drift', (page) => { page.foundationEdit.operatorCounts.m = 7; }],
    ['line formula', (page) => { page.lines[0] = [9, 775, 18, 775]; }],
    ['page extra', (page) => { page.extra = true; }],
    ['foundation extra', (page) => { page.foundationEdit.extra = true; }],
    ['getter', (page) => { Object.defineProperty(page, 'reference', { enumerable: true, get: () => '4 0 R' }); }],
    ['symbol', (page) => { page[Symbol('extra')] = true; }],
    ['non-enumerable', (page) => { Object.defineProperty(page, 'extra', { value: true }); }],
    ['operation proof extra', (_page, value) => { value.artifact.operation.parameters.pages[0].extra = true; }],
    ['operation proof getter', (_page, value) => { Object.defineProperty(value.artifact.operation.parameters.pages[0], 'lines', { enumerable: true, get: () => [] }); }],
    ['operation proof symbol', (_page, value) => { value.artifact.operation.parameters.pages[0][Symbol('extra')] = true; }],
  ];
  for (const [label, mutate] of tamperCases) {
    const client = new LocalHostClient({
      fetchImpl: async (path) => {
        if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
        const value = result(); mutate(value.pages[0], value);
        return { ok: true, status: 201, json: async () => ({ result: value }) };
      },
    });
    await client.bootstrap();
    let rejected = false;
    try {
      await client.createPrinterMarks(documentId, sourceSha256, { pages: [1] });
    } catch (error) {
      rejected = true;
      assert.equal(error.code, 'INVALID_LOCAL_HOST', label);
    }
    assert.equal(rejected, true, label);
  }
});
