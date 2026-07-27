import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PdfIncrementalGoToLinkService } from '../scripts/host/pdf-incremental-goto-link-service.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const request = Object.freeze({
  profile: 'local-incremental-goto-link-v1', sourcePage: 1, targetPage: 1,
  rect: Object.freeze({ left: 0, bottom: 0, right: 1, top: 1 }),
});

function expectedProof(source, output) {
  return Object.freeze({
    profile: request.profile, sourceBytes: source.length, outputBytes: output.length,
    appendedBytes: output.length - source.length, sourcePrefixPreserved: true,
    revisionCount: 2, previousXrefOffset: 10, appendedXrefOffset: source.length,
    sourcePage: 1, targetPage: 1, rect: request.rect,
    sourcePageObjectNumber: 3, targetPageObjectNumber: 3,
    linkAnnotationObjectNumber: 5, annotationCount: 1, effectiveSize: 6,
    rootPreserved: true, infoPreserved: true, idPolicy: 'absent',
  });
}

async function fixture(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'goto-link-service-negative-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = Buffer.from(`%PDF-1.4\n${'source '.repeat(20)}\nstartxref\n10\n%%EOF\n`);
  const output = Buffer.concat([source, Buffer.from('append '.repeat(20))]);
  const digest = createHash('sha256').update(source).digest('hex');
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, source, { mode: 0o600 });
  const proof = expectedProof(source, output);
  const observed = { deleted: [], promoted: 0, workspaces: 0, outputSwapped: false };
  const controller = options.controller ?? new AbortController();
  const store = {
    getDocument: () => ({ id: documentId, sha256: digest, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(
      createHash('sha256').update(await readFile(sourcePath)).digest('hex'), digest,
    ),
    createJobWorkspace: async () => {
      const path = await mkdtemp(join(root, 'job-'));
      await chmod(path, 0o700); observed.workspaces += 1; return path;
    },
    cleanupJob: async (path) => {
      await rm(path, { recursive: true, force: true });
      if (options.cleanupFailure) throw new Error('cleanup failed');
    },
    promotePdfArtifact: async (_id, _path, promotion) => {
      observed.promoted += 1;
      if (options.abortAfterPromotion) controller.abort(new Error('cancelled after promotion'));
      return {
        id: '22222222-2222-4222-8222-222222222222',
        sha256: promotion.expectedSha256, displayName: 'goto.pdf',
        operation: promotion.operation,
      };
    },
    deleteArtifact: async (id) => {
      observed.deleted.push(id);
      if (options.deleteFailure) throw new Error('delete failed');
    },
  };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const poppler = { execute: async (operation, parameters) => {
    if (operation === 'inspect') return { stdout: 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\n', stderr: '' };
    if (['inspectMetadata', 'inspectCustomMetadata'].includes(operation)) return { stdout: '', stderr: '' };
    if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' };
    if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
    if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
    if (operation === 'inspectPageBoxes') return { stdout: 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\n', stderr: '' };
    if (operation === 'extractText') return { stdout: 'fixture\f', stderr: '' };
    if (operation === 'renderPagePng') {
      if (options.swapOutput && parameters.input.endsWith('output.pdf')
        && !observed.outputSwapped) {
        await unlink(parameters.input);
        await writeFile(parameters.input, output, { mode: 0o400 });
        observed.outputSwapped = true;
      }
      await writeFile(`${parameters.outputPrefix}.png`, png); return { stdout: '', stderr: '' };
    }
    assert.fail(operation);
  } };
  const core = {
    normalizeIncrementalGoToLink: (value) => value,
    writeIncrementalPdfGoToLink: (input) => options.overlap
      ? { bytes: input, proof } : { bytes: Buffer.from(output), proof },
    inspectIncrementalPdfGoToLink: () => options.proofMismatch
      ? { ...proof, annotationCount: 2 } : proof,
  };
  return {
    service: new PdfIncrementalGoToLinkService({ store, poppler, core }),
    digest, controller, observed,
  };
}

test('GoTo-link service rejects stale, overlapping, and proof-mismatched work', async (context) => {
  const stale = await fixture(context);
  await assert.rejects(stale.service.update(documentId, request, {
    sourceSha256: '0'.repeat(64),
  }), { code: 'SOURCE_VERSION_MISMATCH' });
  assert.equal(stale.observed.workspaces, 0);
  for (const [options, code] of [
    [{ overlap: true }, 'INCREMENTAL_GOTO_LINK_OUTPUT_INVALID'],
    [{ proofMismatch: true }, 'INCREMENTAL_GOTO_LINK_OUTPUT_INVALID'],
    [{ swapOutput: true }, 'INCREMENTAL_GOTO_LINK_WORKSPACE_INVALID'],
  ]) {
    const setup = await fixture(context, options);
    await assert.rejects(setup.service.update(documentId, request, {
      sourceSha256: setup.digest,
    }), { code });
    assert.equal(setup.observed.promoted, 0);
  }
});

test('GoTo-link service revokes promotion after cancellation or cleanup failure', async (context) => {
  const cancelled = await fixture(context, { abortAfterPromotion: true });
  await assert.rejects(cancelled.service.update(documentId, request, {
    sourceSha256: cancelled.digest, signal: cancelled.controller.signal,
  }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(cancelled.observed.deleted, ['22222222-2222-4222-8222-222222222222']);

  const cleanup = await fixture(context, { cleanupFailure: true });
  await assert.rejects(cleanup.service.update(documentId, request, {
    sourceSha256: cleanup.digest,
  }), { code: 'INCREMENTAL_GOTO_LINK_CLEANUP_FAILED' });
  assert.deepEqual(cleanup.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
});

function classicPdf() {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  const chunks = ['%PDF-1.4\n']; const offsets = [];
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

test('installed Poppler service publishes a verified incremental GoTo-link artifact', { timeout: 30_000 }, async (context) => {
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
  const registry = new EngineRegistry({ runner });
  const required = ['pdfinfo', 'pdftotext', 'pdftocairo', 'pdfdetach', 'pdfsig'];
  if ((await Promise.allSettled(required.map((name) => registry.probe(name))))
    .some(({ status }) => status === 'rejected')) {
    context.skip('Required Poppler tools are unavailable.'); return;
  }
  const root = await mkdtemp(join(tmpdir(), 'goto-link-service-poppler-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const document = await store.createDocument({
    stream: Readable.from([classicPdf()]), displayName: 'classic.pdf',
    mediaType: 'application/pdf',
  });
  const service = new PdfIncrementalGoToLinkService({
    store, poppler: new PopplerAdapter({ registry, runner }),
  });
  const result = await service.update(document.id, request, { sourceSha256: document.sha256 });
  assert.notEqual(result.artifact.sha256, document.sha256);
  assert.equal(result.evidence.pageValidationRendersMatched, true);
  assert.equal(await store.verifySource(document.id), true);
});
