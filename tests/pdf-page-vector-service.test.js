import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createPdfPageVectorService,
  PdfPageVectorService,
} from '../scripts/host/pdf-page-vector-service.mjs';
import { INCREMENTAL_PAGE_VECTOR_PROFILE } from '../scripts/host/pdf-page-vector-contract.mjs';
import {
  inspectIncrementalPdfPageVector,
  writeIncrementalPdfPageVector,
} from '../scripts/host/pdf-page-vector-writer.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const request = Object.freeze({
  profile: INCREMENTAL_PAGE_VECTOR_PROFILE,
  page: 1,
  rect: Object.freeze({ x: 10, y: 10, width: 50, height: 50 }),
});
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(32).fill(0)]);

function sourcePdf() {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] >>',
  ];
  const chunks = ['%PDF-1.7\n'];
  const offsets = [];
  bodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 5\n0000000000 65535 f \n');
  offsets.forEach((offset) => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function info() {
  return 'Pages: 2\nEncrypted: no\nForm: none\nJavaScript: no\nTitle: source\n';
}

function boxes() {
  return [1, 2].flatMap((page) => [
    `Page ${page} size: 100 x 100 pts`,
    `Page ${page} rot: 0`,
    `Page ${page} MediaBox: 0 0 100 100`,
    `Page ${page} CropBox: 0 0 100 100`,
  ]).join('\n') + '\n';
}

function makeFixture({ abortAfterPromotion = false, cleanupFailure = false } = {}) {
  return (async () => {
    const root = await mkdtemp(join(tmpdir(), 'page-vector-service-'));
    const source = sourcePdf();
    const sourcePath = join(root, 'source.pdf');
    await writeFile(sourcePath, source, { mode: 0o600 });
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const calls = { write: 0, inspect: 0, verify: 0, clean: 0, deleted: null };
    const controller = new AbortController();
    const store = {
      getDocument: () => ({ id: documentId, sha256: sourceSha256, size: source.length, displayName: 'source.pdf' }),
      getSourcePath: () => sourcePath,
      verifySource: async () => {
        calls.verify += 1;
        assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha256);
      },
      createJobWorkspace: async () => {
        const path = await mkdtemp(join(root, 'job-'));
        await chmod(path, 0o700);
        return path;
      },
      cleanupJob: async (path) => {
        calls.clean += 1;
        if (cleanupFailure) throw new Error('cleanup refused');
        await rm(path, { recursive: true, force: true });
      },
      promotePdfArtifact: async (_id, path, options) => {
        const bytes = await readFile(path);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), options.expectedSha256);
        const artifact = { id: 'artifact', sha256: options.expectedSha256, displayName: options.displayName, operation: options.operation };
        if (abortAfterPromotion) controller.abort(new Error('cancel after promotion'));
        return artifact;
      },
      deleteArtifact: async (id) => { calls.deleted = id; },
    };
    const poppler = {
      async execute(operation, parameters) {
        const output = parameters.input.endsWith('output.pdf');
        if (operation === 'inspect') return { stdout: info(), stderr: '' };
        if (operation === 'inspectMetadata') return { stdout: '', stderr: '' };
        if (operation === 'inspectCustomMetadata') return { stdout: '', stderr: '' };
        if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' };
        if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
        if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
        if (operation === 'inspectPageBoxes') return { stdout: boxes(), stderr: '' };
        if (operation === 'extractText') return { stdout: '\f', stderr: '' };
        if (operation === 'renderPagePng') {
          const bytes = output && parameters.page === 1 ? Buffer.concat([PNG, Buffer.from([1])]) : PNG;
          await writeFile(`${parameters.outputPrefix}.png`, bytes);
          return { stdout: '', stderr: '' };
        }
        assert.fail(`unexpected Poppler operation ${operation}`);
      },
    };
    const core = {
      normalizeIncrementalPageVector: (value) => {
        if (value !== request) throw Object.assign(new Error('invalid'), { code: 'INVALID_INCREMENTAL_PAGE_VECTOR' });
        return request;
      },
      writeIncrementalPdfPageVector: (input, value) => {
        calls.write += 1;
        assert.deepEqual(input, source);
        const result = writeIncrementalPdfPageVector(input, value);
        return result;
      },
      inspectIncrementalPdfPageVector: (input, output, value) => {
        calls.inspect += 1;
        return inspectIncrementalPdfPageVector(input, output, value);
      },
    };
    return {
      root,
      sourceSha256,
      calls,
      controller,
      service: new PdfPageVectorService({ store, poppler, core }),
      factory: createPdfPageVectorService({ store, poppler, core }),
    };
  })();
}

test('page-vector service independently re-inspects and promotes a source-bound artifact', async (context) => {
  const fixture = await makeFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await fixture.service.update(documentId, request, { sourceSha256: fixture.sourceSha256 });
  assert.equal(result.kind, 'pdf-incremental-page-vector');
  assert.equal(result.artifact.sha256 !== fixture.sourceSha256, true);
  assert.deepEqual(result.vector, { page: 1, rect: request.rect });
  assert.equal(result.evidence.targetPageRenderDiffered, true);
  assert.equal(result.evidence.otherPageRendersMatched, true);
  assert.equal(fixture.calls.write, 1);
  assert.equal(fixture.calls.inspect, 1);
  assert.equal(fixture.calls.verify, 2);
  assert.equal(fixture.calls.clean, 2);
  assert.equal(fixture.factory instanceof PdfPageVectorService, true);
});

test('page-vector service rolls back a promoted artifact on cancellation and cleanup failure', async (context) => {
  const cancelled = await makeFixture({ abortAfterPromotion: true });
  context.after(() => rm(cancelled.root, { recursive: true, force: true }));
  await assert.rejects(
    cancelled.service.update(documentId, request, { sourceSha256: cancelled.sourceSha256, signal: cancelled.controller.signal }),
    { code: 'JOB_CANCELLED' },
  );
  assert.equal(cancelled.calls.deleted, 'artifact');

  const cleanup = await makeFixture({ cleanupFailure: true });
  context.after(() => rm(cleanup.root, { recursive: true, force: true }));
  await assert.rejects(
    cleanup.service.update(documentId, request, { sourceSha256: cleanup.sourceSha256 }),
    { code: 'INCREMENTAL_PAGE_VECTOR_CLEANUP_FAILED' },
  );
});
