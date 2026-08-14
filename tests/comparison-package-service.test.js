import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ComparisonService } from '../scripts/host/comparison-service.mjs';
import { ComparisonPackageService } from '../scripts/host/comparison-package-service.mjs';
import { COMPARISON_PACKAGE_EXTENSION, COMPARISON_PACKAGE_MEDIA_TYPE, validateComparisonPackage } from '../scripts/host/comparison-package-contract.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { readZipEntries } from '../scripts/host/zip-reader.mjs';
import { makeTextPdf } from './pdf-fixture.js';

function png(red) { return encodeRgbaPng({ width: 1, height: 1, pixels: Buffer.from([red, 0, 0, 255]) }); }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pdf-comparison-package-')); const store = await new DocumentStore({ root }).initialize();
  const primary = await store.createDocument({ stream: Readable.from([makeTextPdf('PRIMARY')]), displayName: 'primary.pdf' });
  const revision = await store.createDocument({ stream: Readable.from([makeTextPdf('REVISION')]), displayName: 'revision.pdf' });
  const pdf = {
    inspect: async () => ({ pageCount: 1 }),
    extractText: async (id) => [{ page: 1, text: id === primary.id ? 'old text' : 'new text' }],
    renderThumbnail: async (id) => png(id === primary.id ? 0 : 10),
  };
  const comparison = new ComparisonService({ store, pdfService: pdf });
  return { root, store, primary, revision, comparison, service: new ComparisonPackageService({ store, comparison }) };
}

function options(primary, revision, extra = {}) { return { primarySha256: primary.sha256, revisionSha256: revision.sha256, ...extra }; }

test('comparison package is deterministic, privacy-minimal, source-bound, and retained through its narrow artifact type', async (context) => {
  const value = await fixture(); context.after(() => value.store.dispose());
  const first = await value.service.create(value.primary.id, value.revision.id, options(value.primary, value.revision));
  const second = await value.service.create(value.primary.id, value.revision.id, options(value.primary, value.revision));
  const firstStored = value.store.getArtifact(first.artifact.id); const secondStored = value.store.getArtifact(second.artifact.id);
  const firstBytes = await readFile(firstStored.filePath); const secondBytes = await readFile(secondStored.filePath);
  assert.deepEqual(firstBytes, secondBytes); assert.equal(first.artifact.sha256, second.artifact.sha256);
  assert.equal(firstStored.mediaType, COMPARISON_PACKAGE_MEDIA_TYPE); assert.ok(firstStored.displayName.endsWith(`.${COMPARISON_PACKAGE_EXTENSION}`));
  assert.equal(firstStored.operation.type, 'comparison-package'); assert.deepEqual(firstStored.operation.inputs.map(({ documentId, sha256, role }) => ({ documentId, sha256, role })), [
    { documentId: value.primary.id, sha256: value.primary.sha256, role: 'primary' },
    { documentId: value.revision.id, sha256: value.revision.sha256, role: 'revision' },
  ]);
  const validated = validateComparisonPackage(firstBytes, value.primary.sha256, value.revision.sha256);
  assert.deepEqual([...validated.entries.keys()].sort(), ['manifest.json', 'receipts/content.json']);
  const allText = [...validated.entries.values()].map((bytes) => bytes.toString('utf8')).join('\n');
  assert.equal(allText.includes(value.primary.id), false); assert.equal(allText.includes(value.revision.id), false); assert.equal(allText.includes('%PDF-'), false);
  await value.store.deleteArtifact(first.artifact.id); await value.store.deleteArtifact(second.artifact.id);
});

test('comparison package optionally contains exact source-bound visual receipt and bounded diff PNG', async (context) => {
  const value = await fixture(); context.after(() => value.store.dispose());
  const result = await value.service.create(value.primary.id, value.revision.id, options(value.primary, value.revision, { includeVisual: true, dpi: 72 }));
  const bytes = await readFile(value.store.getArtifact(result.artifact.id).filePath); const entries = readZipEntries(bytes);
  assert.deepEqual([...entries.keys()].sort(), ['diff/page-001.png', 'manifest.json', 'receipts/content.json', 'receipts/visual.json']);
  const visual = JSON.parse(entries.get('receipts/visual.json').toString('utf8'));
  assert.equal(visual.inputs[0].sha256, value.primary.sha256); assert.equal(visual.inputs[1].sha256, value.revision.sha256);
  assert.equal(visual.pages[0].differenceImage.sha256, createHash('sha256').update(entries.get('diff/page-001.png')).digest('hex'));
  assert.equal(result.receiptDigests.visual, createHash('sha256').update(entries.get('receipts/visual.json')).digest('hex'));
  await value.store.deleteArtifact(result.artifact.id);
});

test('comparison package rejects forged receipts, source mismatch, hostile options, and cancellation before publication', async (context) => {
  const value = await fixture(); context.after(() => value.store.dispose());
  await assert.rejects(value.service.create(value.primary.id, value.revision.id, { ...options(value.primary, value.revision), revisionSha256: 'f'.repeat(64) }), { code: 'COMPARISON_SOURCE_MISMATCH' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(value.service.create(value.primary.id, value.revision.id, options(value.primary, value.revision, { signal: controller.signal })), { code: 'JOB_CANCELLED' });
  const hostile = options(value.primary, value.revision); Object.defineProperty(hostile, 'includeVisual', { enumerable: true, get: () => true });
  await assert.rejects(value.service.create(value.primary.id, value.revision.id, hostile), { name: 'TypeError' });
  const forged = new ComparisonPackageService({ store: value.store, comparison: {
    compareContent: async () => ({}), comparePixels: async () => ({}),
    exportContentReport: () => ({ mediaType: 'application/json', extension: 'json', data: JSON.stringify({ kind: 'content', inputs: [{ role: 'primary', sha256: '0'.repeat(64) }, { role: 'secondary', sha256: value.revision.sha256 }], stats: {}, pages: [] }) }),
  } });
  await assert.rejects(forged.create(value.primary.id, value.revision.id, options(value.primary, value.revision)), { code: /COMPARISON_(?:RECEIPT_INVALID|SOURCE_MISMATCH)/u });
  const visual = await value.comparison.comparePixels(value.primary.id, value.revision.id);
  const badPage = { ...visual.pages[0], differenceImage: { ...visual.pages[0].differenceImage, sha256: '0'.repeat(64) } };
  const forgedVisual = new ComparisonPackageService({ store: value.store, comparison: {
    compareContent: value.comparison.compareContent.bind(value.comparison), exportContentReport: value.comparison.exportContentReport.bind(value.comparison),
    comparePixels: async () => ({ ...visual, pages: [badPage] }),
  } });
  await assert.rejects(forgedVisual.create(value.primary.id, value.revision.id, options(value.primary, value.revision, { includeVisual: true })), { code: 'COMPARISON_RECEIPT_INVALID' });
});

test('comparison package stops before workspace or promotion when either source changes', async () => {
  const value = await fixture(); let verifies = 0; let workspace = false; let promoted = false;
  const store = {
    getDocument: value.store.getDocument.bind(value.store),
    verifySource: async () => { verifies += 1; if (verifies > 2) throw Object.assign(new Error('changed'), { code: 'SOURCE_INTEGRITY_FAILED' }); return true; },
    createJobWorkspace: async () => { workspace = true; return value.store.createJobWorkspace(value.primary.id); }, cleanupJob: value.store.cleanupJob.bind(value.store),
    promoteComparisonPackageArtifact: async () => { promoted = true; }, deleteArtifact: value.store.deleteArtifact.bind(value.store),
  };
  await assert.rejects(new ComparisonPackageService({ store, comparison: value.comparison }).create(value.primary.id, value.revision.id, options(value.primary, value.revision)), { code: 'SOURCE_INTEGRITY_FAILED' });
  assert.equal(workspace, false); assert.equal(promoted, false); await value.store.dispose();
});

test('comparison package revokes a trusted artifact when workspace cleanup fails', async () => {
  const value = await fixture(); const content = await value.comparison.compareContent(value.primary.id, value.revision.id);
  const deleted = [];
  const store = {
    getDocument: value.store.getDocument.bind(value.store), verifySource: value.store.verifySource.bind(value.store),
    createJobWorkspace: value.store.createJobWorkspace.bind(value.store), cleanupJob: async () => { throw Object.assign(new Error('cleanup'), { code: 'CLEANUP_FAILED' }); },
    promoteComparisonPackageArtifact: async (primaryId, _revisionId, path, promotion) => ({ id: '33333333-3333-4333-8333-333333333333', documentId: primaryId, displayName: 'comparison.pdfcompare', mediaType: promotion.mediaType, size: (await readFile(path)).length, sha256: promotion.expectedSha256, operation: promotion.operation }),
    deleteArtifact: async (id) => deleted.push(id),
  };
  const comparison = { compareContent: async () => content, exportContentReport: value.comparison.exportContentReport.bind(value.comparison), comparePixels: value.comparison.comparePixels.bind(value.comparison) };
  await assert.rejects(new ComparisonPackageService({ store, comparison }).create(value.primary.id, value.revision.id, options(value.primary, value.revision)), { code: 'COMPARISON_PACKAGE_CLEANUP_FAILED' });
  assert.deepEqual(deleted, ['33333333-3333-4333-8333-333333333333']); await value.store.dispose();
});

test('comparison package cleanup error retains simultaneous revocation failure', async () => {
  const value = await fixture(); const content = await value.comparison.compareContent(value.primary.id, value.revision.id);
  const store = {
    getDocument: value.store.getDocument.bind(value.store), verifySource: value.store.verifySource.bind(value.store), createJobWorkspace: value.store.createJobWorkspace.bind(value.store),
    cleanupJob: async () => { throw Object.assign(new Error('cleanup'), { code: 'CLEANUP_FAILED' }); },
    promoteComparisonPackageArtifact: async (primaryId, _revisionId, path, promotion) => ({ id: '44444444-4444-4444-8444-444444444444', documentId: primaryId, displayName: 'comparison.pdfcompare', mediaType: promotion.mediaType, size: (await readFile(path)).length, sha256: promotion.expectedSha256, operation: promotion.operation }),
    deleteArtifact: async () => { throw Object.assign(new Error('revoke'), { code: 'REVOKE_FAILED' }); },
  };
  const comparison = { compareContent: async () => content, exportContentReport: value.comparison.exportContentReport.bind(value.comparison), comparePixels: value.comparison.comparePixels.bind(value.comparison) };
  await assert.rejects(new ComparisonPackageService({ store, comparison }).create(value.primary.id, value.revision.id, options(value.primary, value.revision)), (error) => error.code === 'COMPARISON_PACKAGE_CLEANUP_FAILED' && error instanceof AggregateError && error.cause instanceof AggregateError && error.errors.map(({ code }) => code).sort().join(',') === 'CLEANUP_FAILED,REVOKE_FAILED');
  await value.store.dispose();
});

test('comparison package never revokes an unrelated artifact named by a forged store result', async () => {
  const value = await fixture(); const content = await value.comparison.compareContent(value.primary.id, value.revision.id); const deleted = [];
  const store = {
    getDocument: value.store.getDocument.bind(value.store), verifySource: value.store.verifySource.bind(value.store), createJobWorkspace: value.store.createJobWorkspace.bind(value.store), cleanupJob: value.store.cleanupJob.bind(value.store),
    promoteComparisonPackageArtifact: async () => ({ id: '55555555-5555-4555-8555-555555555555', documentId: value.revision.id, displayName: 'unrelated.pdfcompare', mediaType: COMPARISON_PACKAGE_MEDIA_TYPE, size: 1, sha256: '0'.repeat(64), operation: { type: 'comparison-package', inputs: [] } }),
    deleteArtifact: async (id) => deleted.push(id),
  };
  const comparison = { compareContent: async () => content, exportContentReport: value.comparison.exportContentReport.bind(value.comparison), comparePixels: value.comparison.comparePixels.bind(value.comparison) };
  await assert.rejects(new ComparisonPackageService({ store, comparison }).create(value.primary.id, value.revision.id, options(value.primary, value.revision)), { code: 'COMPARISON_PACKAGE_ARTIFACT_INVALID' });
  assert.deepEqual(deleted, []); await value.store.dispose();
});

test('comparison package cancellation after trusted promotion revokes the artifact', async () => {
  const value = await fixture(); const content = await value.comparison.compareContent(value.primary.id, value.revision.id); const controller = new AbortController(); const deleted = [];
  const store = {
    getDocument: value.store.getDocument.bind(value.store), verifySource: value.store.verifySource.bind(value.store), createJobWorkspace: value.store.createJobWorkspace.bind(value.store), cleanupJob: value.store.cleanupJob.bind(value.store),
    promoteComparisonPackageArtifact: async (primaryId, _revisionId, path, promotion) => { controller.abort(); return { id: '66666666-6666-4666-8666-666666666666', documentId: primaryId, displayName: 'comparison.pdfcompare', mediaType: promotion.mediaType, size: (await readFile(path)).length, sha256: promotion.expectedSha256, operation: promotion.operation }; },
    deleteArtifact: async (id) => deleted.push(id),
  };
  const comparison = { compareContent: async () => content, exportContentReport: value.comparison.exportContentReport.bind(value.comparison), comparePixels: value.comparison.comparePixels.bind(value.comparison) };
  await assert.rejects(new ComparisonPackageService({ store, comparison }).create(value.primary.id, value.revision.id, options(value.primary, value.revision, { signal: controller.signal })), { code: 'JOB_CANCELLED' });
  assert.deepEqual(deleted, ['66666666-6666-4666-8666-666666666666']); await value.store.dispose();
});

test('document store comparison promotion rejects wrong type and wrong revision provenance', async (context) => {
  const value = await fixture(); context.after(() => value.store.dispose()); const output = join(value.root, 'package.pdfcompare'); const bytes = Buffer.from('not empty'); await writeFile(output, bytes);
  const operation = createOperationProvenance({ type: 'comparison-package', inputs: [{ documentId: value.primary.id, sha256: value.primary.sha256, role: 'primary' }, { documentId: value.revision.id, sha256: 'f'.repeat(64), role: 'revision' }], validation: { passed: true, validators: ['fixture'] } });
  await assert.rejects(value.store.promoteComparisonPackageArtifact(value.primary.id, value.revision.id, output, { displayName: 'bad.pdfcompare', mediaType: 'application/zip', extension: 'pdfcompare', operation, expectedSha256: createHash('sha256').update(bytes).digest('hex') }), { code: 'INVALID_COMPARISON_PACKAGE_ARTIFACT' });
  await assert.rejects(value.store.promoteComparisonPackageArtifact(value.primary.id, value.revision.id, output, { displayName: 'bad.pdfcompare', mediaType: COMPARISON_PACKAGE_MEDIA_TYPE, extension: 'pdfcompare', operation, expectedSha256: createHash('sha256').update(bytes).digest('hex') }), { code: 'INVALID_COMPARISON_PACKAGE_ARTIFACT' });
  const validProvenance = createOperationProvenance({ type: 'comparison-package', inputs: [{ documentId: value.primary.id, sha256: value.primary.sha256, role: 'primary' }, { documentId: value.revision.id, sha256: value.revision.sha256, role: 'revision' }], validation: { passed: true, validators: ['fixture'] } });
  await assert.rejects(value.store.promoteComparisonPackageArtifact(value.primary.id, value.revision.id, output, { displayName: 'bad.pdfcompare', mediaType: COMPARISON_PACKAGE_MEDIA_TYPE, extension: 'pdfcompare', operation: validProvenance, expectedSha256: createHash('sha256').update(bytes).digest('hex') }), { code: 'INVALID_ARCHIVE' });
});

test('installed Poppler can create a comparison package, or reports explicit unavailability', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo'].map((path) => access(path))); } catch { context.skip('The fixed Poppler comparison toolchain is unavailable.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'pdf-comparison-package-installed-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  const registry = new EngineRegistry(); const pdf = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const primary = await store.createDocument({ stream: Readable.from([makeTextPdf('OLD')]), displayName: 'old.pdf' }); const revision = await store.createDocument({ stream: Readable.from([makeTextPdf('NEW')]), displayName: 'new.pdf' });
  const comparison = new ComparisonService({ store, pdfService: pdf }); const result = await new ComparisonPackageService({ store, comparison }).create(primary.id, revision.id, options(primary, revision, { includeVisual: true }));
  assert.equal(result.artifact.operation.type, 'comparison-package'); await store.deleteArtifact(result.artifact.id);
});
