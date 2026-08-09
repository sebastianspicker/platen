import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { prepareHtmlPdfDocumentExport } from '../scripts/host/conversion-html-export.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';

const ASSET_ID = '11111111-1111-4111-8111-111111111111';

function operationFor(bytes, {
  sourceFormat = 'html',
  sourceKind = 'html',
  conversionMode = 'libreoffice',
  validators = ['source-sha256', 'libreoffice-exit-zero', 'pdfinfo-page-count'],
} = {}) {
  return createOperationProvenance({
    type: 'html-to-pdf',
    inputs: [{
      assetId: ASSET_ID,
      sha256: createHash('sha256').update('source').digest('hex'),
      role: 'source',
    }],
    parameters: { sourceFormat, sourceKind, conversionMode },
    expected: { minimumPageCount: 1 },
    validation: { passed: true, validators, pageCount: 1 },
  });
}

async function fixture(context, operation = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-html-export-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(async () => {
    await documents.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = createTextPdf({ pages: ['first page', 'second page'], title: 'HTML export' });
  const document = await documents.createDocument({
    stream: Readable.from([bytes]),
    displayName: 'html-export.pdf',
    operation: operationFor(bytes, operation),
  });
  return { documents, document, bytes };
}

function popplerFor({ onInspect } = {}) {
  const operations = [];
  return {
    operations,
    async execute(operation, parameters, options) {
      operations.push([operation, parameters]);
      assert.equal(options.stdin.length > 0, true);
      if (operation === 'inspectStdin') {
        await onInspect?.(options);
        return { stdout: 'Pages: 2\nEncrypted: no\nJavaScript: no\nForm: none\n' };
      }
      if (operation === 'inspectPageStdin') {
        return { stdout: `Page ${parameters.page} size: 612 x 792 pts\n` };
      }
      if (operation === 'extractTextStdin') return { stdout: 'first page\fsecond page' };
      throw new Error(`Unexpected Poppler operation: ${operation}`);
    },
  };
}

test('HTML export returns retained Poppler evidence for exact LibreOffice HTML provenance', async (context) => {
  const { documents, document, bytes } = await fixture(context);
  const poppler = popplerFor();
  const result = await prepareHtmlPdfDocumentExport({ documents, poppler, documentId: document.id });
  assert.deepEqual(Object.keys(result), ['bytes', 'inspection', 'pages', 'textPages']);
  assert.equal(result.bytes.equals(bytes), true);
  assert.equal(result.inspection.pageCount, 2);
  assert.deepEqual(result.pages.map(({ page }) => page), [1, 2]);
  assert.deepEqual(result.textPages.map(({ page }) => page), [1, 2]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.inspection), true);
  assert.equal(Object.isFrozen(result.pages), true);
  assert.equal(Object.isFrozen(result.pages[0]), true);
  assert.equal(Object.isFrozen(result.textPages), true);
  assert.deepEqual(poppler.operations.map(([operation]) => operation), [
    'inspectStdin', 'inspectPageStdin', 'inspectPageStdin', 'extractTextStdin',
  ]);
});

test('HTML export rejects fallback or forged provenance before Poppler', async (context) => {
  for (const operation of [
    { conversionMode: 'text-fallback', validators: ['source-sha256', 'deterministic-text-fallback', 'pdfinfo-page-count'] },
    { sourceFormat: 'htm' },
    { sourceKind: 'text' },
    { validators: ['source-sha256', 'pdfinfo-page-count'] },
  ]) {
    const { documents, document } = await fixture(context, operation);
    await assert.rejects(
      prepareHtmlPdfDocumentExport({ documents, poppler: popplerFor(), documentId: document.id }),
      { code: 'INVALID_HTML_PDF_DOCUMENT', status: 403 },
    );
  }
});

test('HTML export rejects forged passive evidence, source drift, and cancellation', async (context) => {
  const passiveFixture = await fixture(context);
  const activePoppler = popplerFor();
  activePoppler.execute = async (operation, parameters, options) => {
    if (operation === 'inspectStdin') {
      return { stdout: 'Pages: 1\nEncrypted: no\nJavaScript: yes\nForm: none\n' };
    }
    return popplerFor().execute(operation, parameters, options);
  };
  await assert.rejects(
    prepareHtmlPdfDocumentExport({
      documents: passiveFixture.documents, poppler: activePoppler, documentId: passiveFixture.document.id,
    }),
    { code: 'INVALID_HTML_PDF_DOCUMENT' },
  );

  const replacement = createTextPdf({ pages: ['Changed source'], title: 'Changed source' });
  const driftFixture = await fixture(context);
  const sourcePath = driftFixture.documents.getSourcePath(driftFixture.document.id);
  const driftPoppler = popplerFor({
    onInspect: async () => {
      const held = `${sourcePath}.held`;
      await rename(sourcePath, held);
      await writeFile(sourcePath, replacement, { mode: 0o600 });
      await rm(held);
    },
  });
  await assert.rejects(
    prepareHtmlPdfDocumentExport({
      documents: driftFixture.documents, poppler: driftPoppler, documentId: driftFixture.document.id,
    }),
    { code: 'SOURCE_INTEGRITY_FAILED', status: 500 },
  );

  const cancellationFixture = await fixture(context);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareHtmlPdfDocumentExport({
      documents: cancellationFixture.documents,
      poppler: popplerFor(),
      documentId: cancellationFixture.document.id,
      externalSignal: controller.signal,
    }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
});
