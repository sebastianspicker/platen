import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import { PdfIncrementalPageTransitionService } from '../scripts/host/pdf-incremental-page-transition-service.mjs';
import { PdfPageLabelsService } from '../scripts/host/pdf-page-labels-service.mjs';
import { handlers } from '../scripts/host/professional-capability/page-organization.mjs';
import { makeMultiPagePdf } from './pdf-fixture.js';

async function fixture(t) {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdfseparate', '/opt/homebrew/bin/pdfunite']
      .map((path) => access(path)));
  } catch {
    t.skip('Poppler page composition tools are not installed in the fixed engine search path.');
    return null;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-pages-boundary-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const registry = new EngineRegistry();
  const service = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const primary = await store.createDocument({
    stream: Readable.from([makeMultiPagePdf(['First', 'Second', 'Third'], {
      cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]],
    })]), displayName: 'primary.pdf',
  });
  const secondary = await store.createDocument({
    stream: Readable.from([makeMultiPagePdf(['Alpha', 'Beta'])]), displayName: 'secondary.pdf',
  });
  const primaryContext = { store, service, documentId: primary.id, sourceSha256: primary.sha256 };
  const secondaryContext = { secondaryDocumentId: secondary.id, secondarySourceSha256: secondary.sha256 };
  return { store, service, primary, secondary, primaryContext, secondaryContext };
}

async function textPages(store, service, bytes, displayName = 'derived.pdf') {
  const document = await store.createDocument({ stream: Readable.from([bytes]), displayName });
  const inspection = await service.inspect(document.id);
  return (await service.extractText(document.id, inspection.pageCount)).map(({ text }) => text.trim());
}

test('page organization delegates composition to immutable sources and rereads semantically ordered artifacts', async (t) => {
  const context = await fixture(t);
  if (!context) return;
  const { store, service, primaryContext, secondaryContext } = context;

  const merged = await handlers['pages.merge']({ ...primaryContext, ...secondaryContext });
  assert.equal(merged.method, 'source-bound-poppler-merge');
  assert.deepEqual(await textPages(store, service, merged.pdf, 'merged.pdf'), ['First', 'Second', 'Third', 'Alpha', 'Beta']);

  const extracted = await handlers['pages.extract']({ ...primaryContext, pageNumbers: [3, 1] });
  assert.deepEqual(await textPages(store, service, extracted.pdf, 'extract.pdf'), ['Third', 'First']);

  const deleted = await handlers['pages.delete']({ ...primaryContext, deletePages: [2] });
  assert.deepEqual(await textPages(store, service, deleted.pdf, 'deleted.pdf'), ['First', 'Third']);

  const duplicated = await handlers['pages.duplicate']({ ...primaryContext, pageNumbers: [2] });
  assert.deepEqual(await textPages(store, service, duplicated.pdf, 'duplicated.pdf'), ['First', 'Second', 'Second', 'Third']);

  const inserted = await handlers['pages.insert']({ ...primaryContext, ...secondaryContext, afterPage: 1 });
  assert.deepEqual(await textPages(store, service, inserted.pdf, 'inserted.pdf'), ['First', 'Alpha', 'Beta', 'Second', 'Third']);

  const replaced = await handlers['pages.replace']({ ...primaryContext, ...secondaryContext, startPage: 2, endPage: 3 });
  assert.deepEqual(await textPages(store, service, replaced.pdf, 'replaced.pdf'), ['First', 'Alpha', 'Beta']);

  const reversed = await handlers['pages.reverse-interleave']({ ...primaryContext, mode: 'reverse' });
  assert.deepEqual(await textPages(store, service, reversed.pdf, 'reversed.pdf'), ['Third', 'Second', 'First']);

  const interleaved = await handlers['pages.reverse-interleave']({ ...primaryContext, ...secondaryContext, mode: 'interleave' });
  assert.deepEqual(await textPages(store, service, interleaved.pdf, 'interleaved.pdf'), ['First', 'Alpha', 'Second', 'Beta', 'Third']);

  const split = await handlers['pages.split'](primaryContext);
  assert.equal(split.count, 3);
  assert.deepEqual(await Promise.all(split.pdfArtifacts.map((pdf, index) => textPages(store, service, pdf, `split-${index}.pdf`))), [['First'], ['Second'], ['Third']]);

  const byRule = await handlers['pages.split-by-rule']({ ...primaryContext, everyN: 2 });
  assert.equal(byRule.parts, 2);
  assert.deepEqual(await Promise.all(byRule.pdfArtifacts.map((pdf, index) => textPages(store, service, pdf, `rule-${index}.pdf`))), [['First', 'Second'], ['Third']]);
  assert.equal(await store.verifySource(context.primary.id), true);
  assert.equal(await store.verifySource(context.secondary.id), true);
});

test('page organization fails closed for missing source-bound services and artifact tampering', async (t) => {
  await assert.rejects(handlers['pages.merge']({}), { code: 'PAGES_SERVICE_UNAVAILABLE', status: 503 });
  const context = await fixture(t);
  if (!context) return;
  const tamperingService = {
    inspect: context.service.inspect.bind(context.service),
    async mergeDocuments(...args) {
      const artifact = await context.service.mergeDocuments(...args);
      await writeFile(context.store.getArtifact(artifact.id).filePath, Buffer.from('%PDF-1.7\ntampered\n%%EOF\n', 'ascii'));
      return artifact;
    },
  };
  await assert.rejects(
    handlers['pages.merge']({ ...context.primaryContext, ...context.secondaryContext, service: tamperingService }),
    { code: 'PAGES_OUTPUT_INVALID', status: 502 },
  );
});

test('page labels and Dissolve transitions use their bounded source-bound services', async (t) => {
  const context = await fixture(t);
  if (!context) return;
  const pageLabels = new PdfPageLabelsService({ store: context.store });
  const labels = await handlers['pages.labels-numbering']({
    ...context.primaryContext,
    pageLabels,
    ranges: [{ start: 0, style: 'D', prefix: 'P-', startNumber: 1 }],
  });
  assert.equal(labels.method, 'source-bound-page-label-authoring');
  assert.equal(labels.pageCount, 3);

  const incrementalPageTransition = new PdfIncrementalPageTransitionService({ store: context.store });
  const transition = await handlers['pages.transitions']({
    ...context.primaryContext,
    incrementalPageTransition,
    pages: [1],
    transition: 'Dissolve',
    duration: 1,
  });
  assert.equal(transition.method, 'source-bound-incremental-dissolve-transition');
  assert.equal(transition.pageCount, 3);
  assert.equal(transition.pdf.subarray(0, context.primary.size).equals(await readFile(context.store.getSourcePath(context.primary.id))), true);
});
