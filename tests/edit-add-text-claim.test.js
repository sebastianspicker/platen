import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfPageTextService } from '../scripts/host/pdf-page-text-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { PDF_PAGE_TEXT_LIMITATIONS } from '../scripts/host/pdf-page-text-service.mjs';
import { PDF_PAGE_TEXT_PROFILE } from '../scripts/host/pdf-page-text-contract.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { invoke } from './support/host-router-fixture-base.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const request = Object.freeze({ page: 1, x: 10, y: 20, size: 12, text: 'Hello (PDF) \\' });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(32).fill(0)]);

function sourcePdf() {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] >>',
  ];
  const chunks = ['%PDF-1.7\n']; const offsets = [];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 4\n0000000000 65535 f \n'); offsets.forEach((offset) => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

async function fixture({ abortAfterPromotion = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'edit-add-text-')); const source = sourcePdf();
  const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  const sourceSha256 = createHash('sha256').update(source).digest('hex'); const calls = { deleted: null, promoted: null };
  const controller = new AbortController();
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha256, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha256),
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; },
    cleanupJob: async (path) => { await rm(path, { recursive: true, force: true }); },
    promotePdfArtifact: async (_id, path, options) => { const bytes = await readFile(path); calls.promoted = bytes; const artifact = { id: 'artifact', documentId, displayName: options.displayName, mediaType: 'application/pdf', size: bytes.length, sha256: options.expectedSha256, operation: options.operation, createdAt: new Date().toISOString() }; if (abortAfterPromotion) controller.abort(new Error('cancel')); return artifact; },
    deleteArtifact: async (id) => { calls.deleted = id; },
  };
  const poppler = { async execute(operation, parameters) {
    const output = parameters.input.endsWith('output.pdf');
    if (operation === 'inspect') return { stdout: 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\nSuspects: no\nPDF version: 1.7\n', stderr: '' };
    if (operation === 'inspectMetadata' || operation === 'inspectCustomMetadata') return { stdout: '', stderr: '' };
    if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' };
    if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
    if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
    if (operation === 'inspectPageBoxes') return { stdout: 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\n', stderr: '' };
    if (operation === 'extractText') return { stdout: output ? `${request.text}\f` : '\f', stderr: '' };
    if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, output ? Buffer.concat([PNG, Buffer.from([1])]) : PNG); return { stdout: '', stderr: '' }; }
    assert.fail(`unexpected Poppler operation ${operation}`);
  } };
  return { root, sourceSha256, calls, controller, service: new PdfPageTextService({ store, poppler }) };
}

test('edit.add-text claim is the production Helvetica run on a retained passive-page artifact', async (context) => {
  const value = await fixture(); context.after(() => rm(value.root, { recursive: true, force: true }));
  const result = await value.service.insert(documentId, { profile: PDF_PAGE_TEXT_PROFILE, sourceSha256: value.sourceSha256, ...request });
  assert.equal(result.kind, 'pdf-page-text-run');
  assert.equal(result.sourceDigest, value.sourceSha256);
  assert.equal(result.artifact.operation.inputs[0].sha256, value.sourceSha256);
  assert.equal(result.artifact.operation.parameters.page, 1);
  assert.equal(result.artifact.operation.parameters.profile, PDF_PAGE_TEXT_PROFILE);
  assert.equal(result.evidence.writerProofVerified, true);
  assert.equal(result.evidence.targetPageRenderDiffered, true);
  assert.equal(result.evidence.otherPageRendersMatched, true);
  assert.equal(result.artifact.sha256, createHash('sha256').update(value.calls.promoted).digest('hex'));
  assert.match(value.calls.promoted.toString('latin1'), /\/BaseFont \/Helvetica/);
  assert.equal(JSON.stringify(result).includes(request.text), false);
  assert(PDF_PAGE_TEXT_LIMITATIONS.some((entry) => /512 bytes.*printable ASCII.*Helvetica/.test(entry)));
});

test('edit.add-text claim covers cancellation cleanup and authenticated route/client transport', async (context) => {
  const cancelled = await fixture({ abortAfterPromotion: true }); context.after(() => rm(cancelled.root, { recursive: true, force: true }));
  await assert.rejects(cancelled.service.insert(documentId, { profile: PDF_PAGE_TEXT_PROFILE, sourceSha256: cancelled.sourceSha256, ...request, signal: cancelled.controller.signal }), { code: 'JOB_CANCELLED' });
  assert.equal(cancelled.calls.deleted, 'artifact');

  const calls = []; const token = 'c'.repeat(64); const handler = createAppHandler({ staticHandler() {}, store: { deleteArtifact: async () => {} }, service: {}, workspaceState: {}, pageText: { async insert(...args) { calls.push(args); return { artifact: { id: 'route-artifact' }, kind: 'pdf-page-text-run' }; } }, token, host: '127.0.0.1', port: 4173 });
  const body = { profile: PDF_PAGE_TEXT_PROFILE, sourceSha256: 'a'.repeat(64), ...request }; const options = { method: 'POST', url: `/api/documents/${documentId}/page-text`, headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }, body: JSON.stringify(body) };
  assert.equal((await invoke(handler, options)).statusCode, 401); assert.equal(calls.length, 0);
  assert.equal((await invoke(handler, { ...options, headers: { ...options.headers, 'x-platen-token': token } })).statusCode, 201); assert.equal(calls.length, 1);
  const clientCalls = []; const client = new LocalHostClient({ fetchImpl: async (path, init = {}) => { clientCalls.push({ path, init }); if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token })); return new Response(JSON.stringify({ result: { ...resultForClient(body.sourceSha256) } }), { status: 201 }); } });
  await client.bootstrap(); await client.runPageText(documentId, body.sourceSha256, request);
  assert.equal(clientCalls[1].path, `/api/documents/${documentId}/page-text`); assert.deepEqual(JSON.parse(clientCalls[1].init.body), body);
});

function resultForClient(sourceSha256) {
  const outputSha256 = 'b'.repeat(64); const timestamp = '2026-08-03T12:00:00.000Z';
  return {
    kind: 'pdf-page-text-run',
    sourceDigest: sourceSha256,
    artifact: {
      id: '22222222-2222-4222-8222-222222222222',
      documentId,
      displayName: 'source-page-text.pdf',
      mediaType: 'application/pdf',
      size: 1024,
      sha256: outputSha256,
      operation: {
        schemaVersion: 1,
        id: '33333333-3333-4333-8333-333333333333',
        type: 'pdf-incremental-page-text',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: {
          profile: PDF_PAGE_TEXT_PROFILE,
          page: 1,
          x: request.x,
          y: request.y,
          size: request.size,
          textSha256: createHash('sha256').update(request.text).digest('hex'),
        },
        expected: {
          pageCount: 1,
          sourceUnchanged: true,
          sourcePrefixPreserved: true,
          classicIncrementalRevisionAppended: true,
          rasterized: false,
        },
        validation: {
          passed: true,
          validators: [
            'source-sha256',
            'private-source-copy',
            'raw-writer-proof',
            'source-prefix-preserved',
            'pdfsig-source-output-unsigned',
            'poppler-passive-envelope',
            'poppler-page-count',
            'poppler-page-boxes',
            'poppler-target-page-text',
            'poppler-render-target-diff-other-pages-match',
            'source-unchanged',
            'artifact-sha256',
          ],
          pageCount: 1,
          renderedPages: 1,
          outputSha256,
        },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    page: 1,
    text: {
      page: 1,
      x: request.x,
      y: request.y,
      size: request.size,
      textSha256: createHash('sha256').update(request.text).digest('hex'),
    },
    evidence: {
      sourceDigestReverified: true,
      sourcePrefixPreserved: true,
      writerProofVerified: true,
      pageCountMatched: true,
      pageBoxesMatched: true,
      targetPageTextMatched: true,
      targetPageRenderDiffered: true,
      otherPageRendersMatched: true,
      outputUnsigned: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: [...PDF_PAGE_TEXT_LIMITATIONS],
    rasterized: false,
    historicalBytesRetained: true,
  };
}
