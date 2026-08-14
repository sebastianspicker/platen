import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { prepareOfficePdfDocumentExport } from '../scripts/host/conversion-office-export.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';

const ASSET_ID = '11111111-1111-4111-8111-111111111111';

function operationFor(bytes, {
  sourceFormat = 'odt',
  sourceKind = 'office',
  conversionMode = 'libreoffice',
  validators = ['source-sha256', 'libreoffice-exit-zero', 'pdfinfo-page-count'],
} = {}) {
  return createOperationProvenance({
    type: 'office-to-pdf',
    inputs: [{ assetId: ASSET_ID, sha256: createHash('sha256').update('source').digest('hex'), role: 'source' }],
    parameters: { sourceFormat, sourceKind, conversionMode },
    expected: { minimumPageCount: 1 },
    validation: { passed: true, validators, pageCount: 1 },
  });
}

async function fixture(context, operation = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-office-export-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(async () => {
    await documents.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = createTextPdf({ pages: ['first page', 'second page'], title: 'ODT export' });
  const document = await documents.createDocument({
    stream: Readable.from([bytes]),
    displayName: 'odt-export.pdf',
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
      if (operation === 'inspectPageStdin') return { stdout: `Page ${parameters.page} size: 612 x 792 pts\n` };
      if (operation === 'extractTextStdin') return { stdout: 'first page\fsecond page' };
      throw new Error(`Unexpected Poppler operation: ${operation}`);
    },
  };
}

test('office export returns deeply frozen evidence for exact LibreOffice ODT provenance', async (context) => {
  const { documents, document, bytes } = await fixture(context);
  const poppler = popplerFor();
  const result = await prepareOfficePdfDocumentExport({
    documents, poppler, documentId: document.id,
  });
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

test('office export rejects fallback or forged operation provenance before Poppler', async (context) => {
  for (const operation of [
    { conversionMode: 'text-fallback', validators: ['source-sha256', 'deterministic-text-fallback', 'pdfinfo-page-count'] },
    { sourceFormat: 'docx' },
    { sourceKind: 'text' },
    { validators: ['source-sha256', 'pdfinfo-page-count'] },
  ]) {
    const { documents, document } = await fixture(context, operation);
    await assert.rejects(
      prepareOfficePdfDocumentExport({ documents, poppler: popplerFor(), documentId: document.id }),
      { code: 'INVALID_OFFICE_PDF_DOCUMENT', status: 403 },
    );
  }
});

test('office export rejects passive-output violations, page bounds, and geometry bounds', async (context) => {
  const { documents, document } = await fixture(context);
  const passivePoppler = popplerFor();
  passivePoppler.execute = async (operation, parameters, options) => {
    if (operation === 'inspectStdin') return { stdout: 'Pages: 1\nEncrypted: yes\nJavaScript: no\nForm: none\n' };
    return popplerFor().execute(operation, parameters, options);
  };
  await assert.rejects(
    prepareOfficePdfDocumentExport({ documents, poppler: passivePoppler, documentId: document.id }),
    { code: 'INVALID_OFFICE_PDF_DOCUMENT' },
  );

  const tooManyPages = popplerFor();
  tooManyPages.execute = async (operation, parameters, options) => {
    if (operation === 'inspectStdin') return { stdout: 'Pages: 33\nEncrypted: no\nJavaScript: no\nForm: none\n' };
    return popplerFor().execute(operation, parameters, options);
  };
  await assert.rejects(
    prepareOfficePdfDocumentExport({ documents, poppler: tooManyPages, documentId: document.id }),
    { code: 'OFFICE_PDF_PAGE_LIMIT' },
  );

  const normal = popplerFor();
  const oversizedPage = popplerFor();
  oversizedPage.execute = async (operation, parameters, options) => {
    if (operation === 'inspectPageStdin') return { stdout: `Page ${parameters.page} size: 14401 x 792 pts\n` };
    return normal.execute(operation, parameters, options);
  };
  await assert.rejects(
    prepareOfficePdfDocumentExport({ documents, poppler: oversizedPage, documentId: document.id }),
    { code: 'PAGE_GEOMETRY_LIMIT' },
  );
});

test('office export rechecks source identity and cancellation', async (context) => {
  const replacement = createTextPdf({ pages: ['Changed source'], title: 'Changed source' });
  const { documents, document } = await fixture(context);
  const sourcePath = documents.getSourcePath(document.id);
  const driftPoppler = popplerFor({
    onInspect: async () => {
      const held = `${sourcePath}.held`;
      await rename(sourcePath, held);
      await writeFile(sourcePath, replacement, { mode: 0o600 });
      await rm(held);
    },
  });
  await assert.rejects(
    prepareOfficePdfDocumentExport({ documents, poppler: driftPoppler, documentId: document.id }),
    { code: 'SOURCE_INTEGRITY_FAILED', status: 500 },
  );

  const cancellationFixture = await fixture(context);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareOfficePdfDocumentExport({
      documents: cancellationFixture.documents,
      poppler: popplerFor(),
      documentId: cancellationFixture.document.id,
      externalSignal: controller.signal,
    }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
});
