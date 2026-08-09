import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';
import { runPageImageExportCommand } from '../scripts/cli/commands/page-image-export.mjs';

function capture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    value: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
  };
}

function fixture({ png = null, staleAfter = false, abortAfterRender = false } = {}) {
  const source = createTextPdf({ text: 'page image export' });
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const document = { id: 'doc-1', mediaType: 'application/pdf', sha256: sourceSha256 };
  const output = png ?? encodeRgbaPng({ width: 2, height: 3, pixels: Buffer.alloc(24, 128) });
  const calls = [];
  let verifyCount = 0;
  const application = {
    store: {
      async verifySource(id) { calls.push(['verifySource', id]); verifyCount += 1; if (staleAfter && verifyCount > 1) throw Object.assign(new Error('stale'), { code: 'SOURCE_INTEGRITY_FAILED' }); return true; },
      getDocument(id) { calls.push(['getDocument', id]); return document; },
    },
    service: {
      async inspect(id, options) { calls.push(['inspect', id, options]); return { pageCount: 2 }; },
      async renderThumbnail(id, options) { calls.push(['renderThumbnail', id, options]); if (abortAfterRender) options.signal?.throwIfAborted?.(); return output; },
    },
  };
  return { application, document, calls, output };
}

function runtimeFor(directory, { abortController = null, publicationError = null } = {}) {
  const outputPath = join(directory, 'page.png');
  return {
    outputPath,
    canonicalOutputTarget: async () => {},
    cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
    async writeExclusiveVerified(path, bytes, signal, finalize) {
      await writeFile(path, bytes, { mode: 0o600 });
      if (abortController) abortController.abort();
      try {
        this.cancelled(signal);
        if (publicationError) throw publicationError;
        await finalize({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
    },
    async emit(_stdout, value) { this.emitted = value; },
  };
}

test('page image export validates source around Poppler render and emits privacy-minimal receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-page-image-export-'));
  try {
    const fixtureValue = fixture();
    const runtime = runtimeFor(directory);
    const stdout = capture();
    await runPageImageExportCommand(fixtureValue.application, { page: 2, dpi: 150, output: runtime.outputPath }, fixtureValue.document, stdout.stream, undefined, runtime);
    assert.equal((await stat(runtime.outputPath)).mode & 0o777, 0o600);
    const receipt = runtime.emitted;
    assert.deepEqual(receipt, {
      kind: 'page-image-export', output: 'page.png', sourceSha256: fixtureValue.document.sha256,
      page: 2, pageCount: 2, dpi: 150, size: fixtureValue.output.length,
      sha256: createHash('sha256').update(fixtureValue.output).digest('hex'), width: 2, height: 3,
      mediaType: 'image/png', limitations: [
        'Raster PNG output only; text, vector, and PDF object extraction are not claimed.',
        'Pixel, color, typography, and general format fidelity are not claimed.',
      ], localOnly: true,
    });
    assert.deepEqual(fixtureValue.calls.map(([name]) => name), ['verifySource', 'getDocument', 'inspect', 'renderThumbnail', 'verifySource', 'getDocument', 'verifySource', 'getDocument']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('page image export rejects forged PNG and stale source without publishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-page-image-export-'));
  try {
    const forged = Buffer.from('89504e470d0a1a0a', 'hex');
    const fixtureValue = fixture({ png: forged });
    const runtime = runtimeFor(directory);
    await assert.rejects(
      runPageImageExportCommand(fixtureValue.application, { page: 1, dpi: 72, output: runtime.outputPath }, fixtureValue.document, capture().stream, undefined, runtime),
      { code: 'INVALID_RENDER_OUTPUT' },
    );
    await assert.rejects(access(runtime.outputPath));

    const stale = fixture({ staleAfter: true });
    const staleRuntime = runtimeFor(directory);
    await assert.rejects(
      runPageImageExportCommand(stale.application, { page: 1, dpi: 72, output: staleRuntime.outputPath }, stale.document, capture().stream, undefined, staleRuntime),
      { code: 'SOURCE_INTEGRITY_FAILED' },
    );
    await assert.rejects(access(staleRuntime.outputPath));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('page image export rolls back publication on cancellation and publication failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-page-image-export-'));
  try {
    const controller = new AbortController();
    const cancelled = fixture();
    const cancelledRuntime = runtimeFor(directory, { abortController: controller });
    await assert.rejects(
      runPageImageExportCommand(cancelled.application, { page: 1, dpi: 72, output: cancelledRuntime.outputPath }, cancelled.document, capture().stream, controller.signal, cancelledRuntime),
      { code: 'JOB_CANCELLED' },
    );
    await assert.rejects(access(cancelledRuntime.outputPath));

    const failed = fixture();
    const failure = Object.assign(new Error('publish failed'), { code: 'CLI_OUTPUT_VERIFICATION_FAILED' });
    const failedRuntime = runtimeFor(directory, { publicationError: failure });
    await assert.rejects(
      runPageImageExportCommand(failed.application, { page: 1, dpi: 72, output: failedRuntime.outputPath }, failed.document, capture().stream, undefined, failedRuntime),
      failure,
    );
    await assert.rejects(access(failedRuntime.outputPath));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('installed Poppler renders deterministic PDF page PNG when available', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-page-image-export-live-'));
  try {
    const sourcePath = join(root, 'source.pdf');
    const outputPath = join(root, 'page.png');
    await writeFile(sourcePath, createTextPdf({ text: 'live page image export' }), { mode: 0o600 });
    try { await access('/opt/homebrew/bin/pdftocairo'); } catch { context.skip('The fixed Poppler renderer is unavailable.'); return; }
    const { createLocalApplication } = await import('../scripts/local-application.mjs');
    const { PdfService } = await import('../scripts/host/pdf-service.mjs');
    const { ComparisonService } = await import('../scripts/host/comparison-service.mjs');
    const application = await createLocalApplication({ root: process.cwd() }, { PdfServiceClass: PdfService, ComparisonServiceClass: ComparisonService });
    try {
      const document = await application.store.createDocument({ stream: (await import('node:fs')).createReadStream(sourcePath), displayName: 'source.pdf' });
      const stdout = capture();
      const runtime = { ...runtimeFor(root), async writeExclusiveVerified(path, bytes, signal, finalize) { const { writeExclusiveVerified } = await import('../scripts/cli/runtime.mjs'); return writeExclusiveVerified(path, bytes, signal, finalize); }, emit: async (_stream, value) => { runtime.emitted = value; }, };
      await runPageImageExportCommand(application, { page: 1, dpi: 72, output: outputPath }, document, stdout.stream, undefined, runtime);
      assert.equal((await readFile(outputPath)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(runtime.emitted.mediaType, 'image/png');
    } finally { await application.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
