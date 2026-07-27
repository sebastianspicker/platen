import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  escapePageTextPdfLiteral,
  normalizePageTextRequest,
  PDF_PAGE_TEXT_PROFILE,
} from '../scripts/host/pdf-page-text-contract.mjs';
import {
  assertPageTextWriterProof,
  createPdfPageTextService,
  PdfPageTextService,
} from '../scripts/host/pdf-page-text-service.mjs';
import { writeIncrementalPdfPageText } from '../scripts/host/pdf-page-vector-writer.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const request = Object.freeze({
  profile: PDF_PAGE_TEXT_PROFILE, page: 1, x: 10, y: 20, size: 12, text: 'Hello (PDF) \\',
});
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(32).fill(0)]);

function sourcePdf() {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /CropBox [0 0 200 200] >>',
  ];
  const chunks = ['%PDF-1.7\n']; const offsets = [];
  bodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 4\n0000000000 65535 f \n');
  offsets.forEach((offset) => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function info() {
  return 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\nSuspects: no\nTitle: source\nPDF version: 1.7\n';
}

function boxes() {
  return 'Page 1 size: 200 x 200 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 200 200\nPage 1 CropBox: 0 0 200 200\n';
}

async function fixture({ proofOverride = null, cleanupFailure = false, abortAfterPromotion = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'page-text-service-'));
  const source = sourcePdf(); const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, source, { mode: 0o600 });
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const calls = { clean: 0, deleted: null, promoted: null };
  const controller = new AbortController();
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha256, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha256),
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; },
    cleanupJob: async (path) => { calls.clean += 1; if (cleanupFailure) throw new Error('cleanup refused'); await rm(path, { recursive: true, force: true }); },
    promotePdfArtifact: async (_id, path, options) => {
      const bytes = await readFile(path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), options.expectedSha256);
      calls.promoted = options;
      if (abortAfterPromotion) controller.abort(new Error('cancel after promotion'));
      return { id: 'artifact', sha256: options.expectedSha256, displayName: options.displayName, operation: options.operation };
    },
    deleteArtifact: async (id) => { calls.deleted = id; },
  };
  const poppler = {
    async execute(operation, parameters) {
      const output = parameters.input?.endsWith('output.pdf');
      if (operation === 'inspect') return { stdout: info(), stderr: '' };
      if (operation === 'inspectMetadata' || operation === 'inspectCustomMetadata') return { stdout: '', stderr: '' };
      if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' };
      if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
      if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
      if (operation === 'inspectPageBoxes') return { stdout: boxes(), stderr: '' };
      if (operation === 'extractText') return { stdout: output ? `${request.text}\f` : '\f', stderr: '' };
      if (operation === 'renderPagePng') {
        await writeFile(`${parameters.outputPrefix}.png`, output ? Buffer.concat([PNG, Buffer.from([1])]) : PNG);
        return { stdout: '', stderr: '' };
      }
      assert.fail(`unexpected Poppler operation ${operation}`);
    },
  };
  const core = proofOverride ? {
    normalizePageTextRequest,
    writeIncrementalPdfPageText(bytes, value) {
      const result = writeIncrementalPdfPageText(bytes, value);
      return Object.freeze({ bytes: result.bytes, proof: proofOverride(result.proof) });
    },
  } : null;
  const options = { store, poppler, ...(core ? { core } : {}) };
  return {
    root, sourceSha256, calls, controller,
    service: new PdfPageTextService(options),
    factory: createPdfPageTextService(options),
  };
}

test('page-text contract rejects noncanonical input and escapes literal delimiters', () => {
  assert.deepEqual(normalizePageTextRequest(request), request);
  assert.equal(escapePageTextPdfLiteral(request.text), 'Hello \\(PDF\\) \\\\');
  for (const text of [' e', 'e ', 'e\n', 'e\u200b', 'e\u0301', 'café']) {
    assert.throws(() => normalizePageTextRequest({ ...request, text }), { code: 'INVALID_PAGE_TEXT' });
  }
  assert.throws(() => normalizePageTextRequest({ ...request, extra: true }), { code: 'INVALID_PAGE_TEXT' });
  const accessor = { ...request }; Object.defineProperty(accessor, 'text', { enumerable: true, get: () => 'secret' });
  assert.throws(() => normalizePageTextRequest(accessor), { code: 'INVALID_PAGE_TEXT' });
});

test('page-text writer proof is exact and request-bound where the writer provides authority', () => {
  const sourceSha256 = 'a'.repeat(64); const outputSha256 = 'b'.repeat(64);
  const proof = Object.freeze({
    profile: PDF_PAGE_TEXT_PROFILE, page: 1, x: request.x, y: request.y,
    size: request.size,
    textSha256: createHash('sha256').update(request.text).digest('hex'),
    sourceSha256, outputSha256, sourcePrefixPreserved: true,
    textStreamObjectNumber: 4, fontObjectNumber: 5, resourceName: 'F1', baseFont: 'Helvetica',
  });
  assert.equal(assertPageTextWriterProof(proof, request, sourceSha256, outputSha256), proof);
  assert.throws(() => assertPageTextWriterProof({ ...proof, resourceName: 'F2' }, request, sourceSha256, outputSha256), { code: 'PDF_PAGE_TEXT_OUTPUT_INVALID' });
  assert.throws(() => assertPageTextWriterProof({ ...proof, extra: true }, request, sourceSha256, outputSha256), { code: 'PDF_PAGE_TEXT_OUTPUT_INVALID' });
});

test('real page-text writer appends a digest-bound escaped text revision', () => {
  const source = sourcePdf();
  const result = writeIncrementalPdfPageText(source, request);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(result.bytes.includes(Buffer.from('(Hello \\(PDF\\) \\\\) Tj', 'ascii')), true);
  assert.equal(result.proof.sourceSha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(result.proof.outputSha256, createHash('sha256').update(result.bytes).digest('hex'));
  assert.equal(result.proof.textSha256, createHash('sha256').update(request.text).digest('hex'));
  assert.deepEqual([result.proof.x, result.proof.y, result.proof.size], [10, 20, 12]);
});

test('page-text service validates, promotes, and returns no raw text or object proof', async (context) => {
  const setup = await fixture(); context.after(() => rm(setup.root, { recursive: true, force: true }));
  const result = await setup.service.insert(documentId, { sourceSha256: setup.sourceSha256, ...request });
  assert.equal(result.kind, 'pdf-page-text-run');
  assert.equal(result.historicalBytesRetained, true);
  assert.equal(result.evidence.writerProofVerified, true);
  assert.equal(result.evidence.targetPageRenderDiffered, true);
  assert.equal(result.text.textSha256, createHash('sha256').update(request.text).digest('hex'));
  assert.equal(JSON.stringify(result).includes(request.text), false);
  assert.equal(JSON.stringify(setup.calls.promoted.operation).includes(request.text), false);
  assert.equal(setup.calls.clean, 2);
  assert.equal(setup.factory instanceof PdfPageTextService, true);
});

test('page-text service rejects malformed proof and rolls back on cancellation or cleanup failure', async (context) => {
  const malformed = await fixture({ proofOverride: (proof) => Object.freeze({ ...proof, resourceName: 'F2' }) });
  context.after(() => rm(malformed.root, { recursive: true, force: true }));
  await assert.rejects(malformed.service.insert(documentId, { sourceSha256: malformed.sourceSha256, ...request }), { code: 'PDF_PAGE_TEXT_OUTPUT_INVALID' });

  const cancelled = await fixture({ abortAfterPromotion: true });
  context.after(() => rm(cancelled.root, { recursive: true, force: true }));
  await assert.rejects(cancelled.service.insert(documentId, { sourceSha256: cancelled.sourceSha256, signal: cancelled.controller.signal, ...request }), { code: 'JOB_CANCELLED' });
  assert.equal(cancelled.calls.deleted, 'artifact');

  const cleanup = await fixture({ cleanupFailure: true });
  context.after(() => rm(cleanup.root, { recursive: true, force: true }));
  await assert.rejects(cleanup.service.insert(documentId, { sourceSha256: cleanup.sourceSha256, ...request }), { code: 'PDF_PAGE_TEXT_CLEANUP_FAILED' });
  assert.equal(cleanup.calls.deleted, 'artifact');
});
