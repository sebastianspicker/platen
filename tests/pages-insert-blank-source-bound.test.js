import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBlankPdf, createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { pagesInsertBlank } from '../scripts/host/professional-capability/page-organization-mutations.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const STANDARD = { widthPoints: 612, heightPoints: 792 };

async function fixture(t, { blank = createBlankPdf({ pages: 1 }), outputTamper = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-insert-blank-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const sourceBytes = createTextPdf({ text: 'source', title: 'source' });
  const source = await store.createDocument({ stream: Readable.from([sourceBytes]), displayName: 'source.pdf' });
  const generated = await store.createDocument({ stream: Readable.from([blank]), displayName: 'blank.pdf' });
  const deleted = [];
  const service = {
    async inspect(documentId) {
      const document = store.getDocument(documentId);
      return { pageCount: documentId === source.id ? 1 : documentId === generated.id ? 1 : 2 };
    },
    async inspectPage(_documentId, page) { return { page, ...STANDARD }; },
    async extractText(documentId, count = 1) {
      if (documentId === generated.id) return [{ page: 1, text: blank.includes(Buffer.from('not blank')) ? 'not blank' : '' }];
      return Array.from({ length: count }, (_, index) => ({ page: index + 1, text: '' }));
    },
    async insertDocument(primaryId, blankId, afterPage) {
      const outputPath = join(root, 'output.pdf');
      const outputBytes = createBlankPdf({ pages: 2 });
      await writeFile(outputPath, outputBytes);
      if (outputTamper) await writeFile(outputPath, Buffer.from('%PDF-1.7\ntampered\n%%EOF\n', 'ascii'));
      const selections = [{ input: 0, page: 1 }, { input: 1, page: 1 }];
      const operation = createOperationProvenance({
        type: 'insert-blank-page',
        inputs: [
          { documentId: primaryId, sha256: source.sha256, role: 'primary' },
          { documentId: blankId, sha256: generated.sha256, role: 'source-1' },
        ],
        parameters: { afterPage, selections },
        expected: { pageCount: 2, manifestSha256: 'a'.repeat(64) },
        validation: { passed: true, validators: ['source-sha256', 'pdfinfo-page-count', 'semantic-page-manifest'], pageCount: 2, manifestSha256: 'a'.repeat(64) },
      });
      return store.promotePdfArtifact(primaryId, outputPath, { operation, expectedSha256: digest(outputBytes) });
    },
  };
  const blankPageFactory = { createBlank: async () => generated };
  const context = {
    store: {
      getDocument: store.getDocument.bind(store),
      verifySource: store.verifySource.bind(store),
      getSourcePath: store.getSourcePath.bind(store),
      getArtifact: store.getArtifact.bind(store),
      createDocument: store.createDocument.bind(store),
      deleteDocument: async (id) => { deleted.push(id); if (id !== generated.id) return store.deleteDocument(id); },
      deleteArtifact: store.deleteArtifact.bind(store),
    },
    service,
    blankPageFactory,
    documentId: source.id,
    sourceSha256: source.sha256,
    afterPage: 1,
  };
  return { context, source, generated, deleted, store };
}

test('pages.insert-blank binds both sources and proves the retained insertion', async (t) => {
  const { context, source, generated, deleted } = await fixture(t);
  const result = await pagesInsertBlank(context);
  assert.equal(result.method, 'source-bound-poppler-insert-blank');
  assert.equal(result.pageCount, 2);
  assert.equal(result.operation.inputs[1].sha256, generated.sha256);
  assert.equal(JSON.stringify(result.operation.parameters.selections), JSON.stringify([{ input: 0, page: 1 }, { input: 1, page: 1 }]));
  assert.equal(deleted.length, 2);
  assert.equal(deleted.at(-1), generated.id);
  assert.equal(result.sourceSha256, source.sha256);
});

test('pages.insert-blank rejects source drift, forged blank, nonempty blank, geometry mismatch, and tampered output', async (t) => {
  const drift = await fixture(t);
  await assert.rejects(pagesInsertBlank({ ...drift.context, sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });

  const forged = await fixture(t);
  await assert.rejects(pagesInsertBlank({ ...forged.context, blankPageFactory: { createBlank: async () => ({ id: forged.generated.id, sha256: 'f'.repeat(64) }) } }), { code: 'PAGES_OUTPUT_INVALID' });

  const nonempty = await fixture(t, { blank: createTextPdf({ text: 'not blank' }) });
  await assert.rejects(pagesInsertBlank(nonempty.context), { code: 'PAGES_OUTPUT_INVALID' });

  const geometry = await fixture(t);
  geometry.context.service.inspectPage = async () => ({ page: 1, widthPoints: 100, heightPoints: 100 });
  await assert.rejects(pagesInsertBlank(geometry.context), { code: 'PAGES_OUTPUT_INVALID' });

  const tampered = await fixture(t, { outputTamper: true });
  await assert.rejects(pagesInsertBlank(tampered.context), { code: 'ARTIFACT_DIGEST_MISMATCH' });
});

test('pages.insert-blank revokes generated source after cancellation and requires cleanup authority', async (t) => {
  const cancelled = await fixture(t);
  const controller = new AbortController();
  cancelled.context.signal = controller.signal;
  cancelled.context.blankPageFactory = { createBlank: async () => { controller.abort(); return cancelled.generated; } };
  await assert.rejects(pagesInsertBlank(cancelled.context), { code: 'JOB_CANCELLED' });
  assert.deepEqual(cancelled.deleted, [cancelled.generated.id]);

  const noCleanup = await fixture(t);
  delete noCleanup.context.store.deleteDocument;
  await assert.rejects(pagesInsertBlank(noCleanup.context), { code: 'PAGES_OUTPUT_INVALID' });
});
