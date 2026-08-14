import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runStructuredExportLocalCommand } from '../scripts/cli/commands/structured-export.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { canonicalOutputTarget, cancelled, writeExclusiveVerified } from '../scripts/cli/runtime.mjs';

const sourceSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function runtimeFor(directory, events = []) {
  return {
    cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); },
    async canonicalOutputTarget(path) { events.push(['target', path]); },
    async writeExclusiveVerified(path, bytes, signal, finalize) {
      events.push(['write', path, bytes]);
      const receipt = { size: bytes.length, sha256: sourceSha256(bytes) };
      await finalize(Object.freeze(receipt));
      await import('node:fs/promises').then(({ writeFile }) => writeFile(join(directory, path), bytes, { mode: 0o600 }));
      return receipt;
    },
    async emit(_stdout, value) { events.push(['emit', value]); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  };
}

function fixtureApplication(pages, { source = createTextPdf({ pages: ['source'] }), onExtract = null } = {}) {
  const document = { id: 'doc', displayName: 'fixture.pdf', sha256: sourceSha256(source) };
  const calls = [];
  return {
    document,
    calls,
    application: {
      store: {
        async verifySource(id) { calls.push(['verify', id]); return true; },
      },
      service: {
        async inspect(id) { calls.push(['inspect', id]); return { pageCount: pages.length }; },
        async extractText(id, count) { calls.push(['extract', id, count]); onExtract?.(); return pages; },
      },
    },
  };
}

test('structured export rejects forged page sequences, NUL output, and mismatched receipts', async () => {
  const fixture = fixtureApplication([{ page: 2, text: 'forged' }]);
  await assert.rejects(
    runStructuredExportLocalCommand(fixture.application, { format: 'rtf', output: 'out.rtf' }, fixture.document, null, undefined, runtimeFor('/tmp')),
    { code: 'CLI_INVALID_STRUCTURED_EXPORT' },
  );
  const malformed = fixtureApplication([{ page: 1, text: 'ok' }]);
  malformed.application.service.extractText = async () => [{ page: 1, text: 'ok\u0000' }];
  await assert.rejects(
    runStructuredExportLocalCommand(malformed.application, { format: 'html', output: 'out.html' }, malformed.document, null, undefined, runtimeFor('/tmp')),
    { code: 'CLI_INVALID_STRUCTURED_EXPORT_OUTPUT' },
  );
  const mismatch = fixtureApplication([{ page: 1, text: 'ok' }]);
  const runtime = runtimeFor('/tmp');
  runtime.writeExclusiveVerified = async (_path, _bytes, _signal, finalize) => finalize(Object.freeze({ size: 1, sha256: '0'.repeat(64) }));
  await assert.rejects(
    runStructuredExportLocalCommand(mismatch.application, { format: 'xml', output: 'out.xml' }, mismatch.document, null, undefined, runtime),
    { code: 'CLI_OUTPUT_VERIFICATION_FAILED' },
  );
});

test('structured export uses installed Poppler and publishes a source-bound XML receipt', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-structured-export-local-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const source = createTextPdf({ pages: ['Alpha <one>', 'Beta & two'], title: 'Fixture' });
  const document = await store.createDocument({
    stream: (async function* stream() { yield source; }()), displayName: 'fixture.pdf',
  });
  const registry = new EngineRegistry();
  const service = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const events = [];
  const outputPath = join(root, 'result.xml');
  await runStructuredExportLocalCommand(
    { store, service },
    { format: 'xml', output: outputPath },
    document,
    null,
    undefined,
    {
      canonicalOutputTarget,
      cancelled,
      writeExclusiveVerified,
      async emit(_stdout, value) { events.push(['emit', value]); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    },
  );
  const emitted = events.find(([kind]) => kind === 'emit')[1];
  assert.equal(emitted.kind, 'structured-export-local');
  assert.equal(emitted.sourceSha256, document.sha256);
  assert.equal(emitted.pageCount, 2);
  assert.equal(emitted.output.mediaType, 'application/xml;charset=utf-8');
  const xml = await readFile(outputPath, 'utf8');
  assert.match(xml, /<page number="1">Alpha &lt;one&gt;<\/page>/u);
  assert.match(xml, /<page number="2">Beta &amp; two<\/page>/u);
  assert.equal((await readFile(store.getSourcePath(document.id))).equals(source), true);
});

test('structured export cancellation before receipt does not publish', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-structured-export-cancel-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const fixture = fixtureApplication([{ page: 1, text: 'cancel me' }], { onExtract: () => controller.abort() });
  await assert.rejects(
    runStructuredExportLocalCommand(fixture.application, { format: 'rtf', output: 'cancel.rtf' }, fixture.document, null, controller.signal, runtimeFor(root)),
    { code: 'JOB_CANCELLED' },
  );
  await assert.rejects(access(join(root, 'cancel.rtf')), { code: 'ENOENT' });
});
