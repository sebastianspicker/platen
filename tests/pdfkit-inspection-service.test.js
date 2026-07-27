import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HostError } from '../scripts/host/host-error.mjs';
import { PdfKitInspectionService } from '../scripts/host/pdfkit-inspection-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceBytes = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
const sourceDigest = '025bfabf088fa4396e6638c23e49688c077386554ebe472d6f941d8974bda128';

async function fixture({ helperPageCount = 2, mutateWorkspace = false, sourceChanges = false, adapterError = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdfkit-service-'));
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  let verified = 0; let cleaned = false; let observed = null;
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceDigest }),
    getSourcePath: () => sourcePath,
    verifySource: async () => { verified += 1; if (sourceChanges && verified > 1) throw new HostError('SOURCE_INTEGRITY_FAILED', 'changed', 500); },
    createJobWorkspace: async () => mkdtemp(join(root, 'job-')),
    cleanupJob: async (workspace) => { cleaned = true; await rm(workspace, { recursive: true, force: true }); },
  };
  const pdfService = { inspect: async () => ({ pageCount: 2 }) };
  const adapter = { inspect: async ({ workspacePath, requestPath }, options) => {
    observed = {
      workspacePath, requestPath, options,
      request: JSON.parse(await readFile(requestPath, 'utf8')),
      inputMode: (await stat(join(workspacePath, 'input.pdf'))).mode & 0o777,
      requestMode: (await stat(requestPath)).mode & 0o777,
    };
    if (adapterError) throw adapterError;
    if (mutateWorkspace) await writeFile(join(workspacePath, 'unexpected.txt'), 'unsafe');
    return {
      document: { pageCount: helperPageCount, encrypted: false, locked: false, permissions: {}, supportedAnnotationTypes: [] },
      metadata: {}, pages: [], pagesTruncated: true, outline: { items: [], truncated: false },
      pageLabels: { present: false, items: [], truncated: true },
      optionalContent: { present: false, groupCount: 0, groups: [], groupsTruncated: false, defaultConfigurationPresent: false },
    };
  } };
  return { service: new PdfKitInspectionService({ store, pdfService, adapter }), dependencies: { store, pdfService, adapter }, state: () => ({ verified, cleaned, observed }) };
}

test('PDFKit inspection uses private immutable inputs and returns bounded read-only evidence', async () => {
  const { service, state } = await fixture();
  const result = await service.inspect(documentId);
  assert.equal(result.kind, 'pdfkit-structure-inspection');
  assert.equal(result.sourceDigest, sourceDigest);
  assert.equal(result.evidence.popplerPageCountMatched, true);
  assert.equal(result.evidence.operationMode, 'inventory-only');
  assert.equal(result.evidence.helperBinaryDigestVerified, true);
  assert.equal(result.evidence.descriptorBackedInput, true);
  assert.equal(result.evidence.activeActionsNotExecuted, true);
  assert.equal(result.evidence.optionalContentCatalogReadOnly, true);
  assert.equal(result.document.pageCount, 2);
  assert.equal(result.pageLabels.present, false);
  assert.equal(result.optionalContent.groupCount, 0);
  assert.equal(Object.isFrozen(result.pages), true);
  assert.equal(state().verified, 2);
  assert.equal(state().cleaned, true);
  assert.equal(state().observed.inputMode, 0o400);
  assert.equal(state().observed.requestMode, 0o400);
  assert.deepEqual(state().observed.request, {
    version: 1, operation: 'inspect', inputFilename: 'input.pdf',
    limits: { maxPages: 100, maxAnnotationsPerPage: 50, maxWidgetsPerPage: 50, maxOutlineDepth: 8, maxOutlineItems: 200 },
  });
  assert.equal(state().observed.options.timeoutMs, 30_000);
});

test('PDFKit inspection rejects helper writes, engine disagreement, and source changes', async () => {
  await assert.rejects((await fixture({ mutateWorkspace: true })).service.inspect(documentId), { code: 'PDFKIT_WORKSPACE_INVALID' });
  await assert.rejects((await fixture({ helperPageCount: 3 })).service.inspect(documentId), { code: 'PDFKIT_PAGE_COUNT_MISMATCH' });
  await assert.rejects((await fixture({ sourceChanges: true })).service.inspect(documentId), { code: 'SOURCE_INTEGRITY_FAILED' });
});

test('PDFKit inspection distinguishes unsupported documents from helper failures', async () => {
  await assert.rejects((await fixture({ adapterError: Object.assign(new Error('unreadable'), { code: 'UNREADABLE_DOCUMENT' }) })).service.inspect(documentId), { code: 'PDFKIT_DOCUMENT_UNSUPPORTED', status: 422 });
  await assert.rejects((await fixture({ adapterError: Object.assign(new Error('bad response'), { code: 'INVALID_RESPONSE' }) })).service.inspect(documentId), { code: 'PDFKIT_INSPECTION_FAILED', status: 502 });
});

test('PDFKit inspection rejects limits beyond the fixed helper protocol', async () => {
  const { dependencies } = await fixture();
  assert.throws(() => new PdfKitInspectionService({ ...dependencies, limits: { maxPages: 101 } }), /fixed local bounds/);
});
