import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';
import { PdfIncrementalBatchLinkService } from '../scripts/host/pdf-incremental-batch-link-service.mjs';
import {
  inspectIncrementalPdfBatchGoToLinks,
  writeIncrementalPdfBatchGoToLinks,
} from '../scripts/host/pdf-incremental-goto-link-writer.mjs';
import { normalizeIncrementalBatchGoToLinks } from '../scripts/host/pdf-incremental-batch-link-contract.mjs';
import { parseCliArguments } from '../scripts/cli/parser.mjs';

function classicPdf() {
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] >>'],
  ]);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 4\n0000000000 65535 f \n');
  for (let number = 1; number <= 3; number += 1) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function classicPdfWithIndirectPassiveAnnotation() {
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Annots 4 0 R >>'],
    [4, '[5 0 R]'],
    [5, '<< /Type /Annot /Subtype /Text /Rect [0 0 5 5] /Contents (existing) >>'],
  ]);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 6\n0000000000 65535 f \n');
  for (let number = 1; number <= 5; number += 1) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

const links = [
  { sourcePage: 1, targetPage: 1, rect: { left: 10, bottom: 10, right: 30, top: 30 } },
  { sourcePage: 1, targetPage: 1, rect: { left: 40, bottom: 40, right: 60, top: 60 } },
];

test('batch-link writer appends multiple direct links in one atomic revision', () => {
  const source = classicPdf();
  const request = { profile: 'local-aec-batch-link-v1', links };
  const result = writeIncrementalPdfBatchGoToLinks(source, request);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(result.proof.links.length, 2);
  assert.equal(result.proof.revisionCount, 2);
  assert.deepEqual(inspectIncrementalPdfBatchGoToLinks(source, result.bytes, request), result.proof);
});

test('batch-link proof distinguishes affected pages from indirect annotation-array updates', () => {
  const source = classicPdfWithIndirectPassiveAnnotation(); const request = { profile: 'local-aec-batch-link-v1', links };
  const result = writeIncrementalPdfBatchGoToLinks(source, request);
  assert.deepEqual(result.proof.updatedPageObjectNumbers, [3]);
  assert.deepEqual(result.proof.updatedObjectNumbers, [4]);
  assert.deepEqual(inspectIncrementalPdfBatchGoToLinks(source, result.bytes, request), result.proof);
});

test('batch-link contract rejects duplicate, overflow, and hostile records', () => {
  const duplicate = { profile: 'local-aec-batch-link-v1', links: [links[0], links[0]] };
  assert.throws(() => normalizeIncrementalBatchGoToLinks(duplicate), { code: 'INVALID_INCREMENTAL_BATCH_LINK' });
  assert.throws(() => normalizeIncrementalBatchGoToLinks({ profile: 'local-aec-batch-link-v1', links: [] }), { code: 'INVALID_INCREMENTAL_BATCH_LINK' });
  const hidden = { profile: 'local-aec-batch-link-v1', links: [links[0]] };
  Object.defineProperty(hidden, 'extra', { value: true });
  assert.throws(() => normalizeIncrementalBatchGoToLinks(hidden), { code: 'INVALID_INCREMENTAL_BATCH_LINK' });
});

test('aec-batch-link CLI parser requires bounded JSON and PDF output paths', () => {
  assert.deepEqual(parseCliArguments(['aec-batch-link', 'input.pdf', '--links', 'links.json', '--output', 'output.pdf']), {
    command: 'aec-batch-link', input: 'input.pdf', links: 'links.json', output: 'output.pdf',
  });
  assert.throws(() => parseCliArguments(['aec-batch-link', 'input.pdf', '--links', 'links.txt', '--output', 'output.pdf']), { code: 'CLI_INVALID_OPTION' });
});

test('batch-link service uses the real DocumentStore and Poppler path when installed', { timeout: 30_000 }, async (context) => {
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 }); const registry = new EngineRegistry({ runner });
  if ((await Promise.allSettled(['pdfinfo', 'pdftotext', 'pdftocairo', 'pdfdetach', 'pdfsig'].map((name) => registry.probe(name)))).some(({ status }) => status === 'rejected')) { context.skip('Required Poppler tools are unavailable.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'batch-link-real-')); const store = await new DocumentStore({ root }).initialize(); context.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const document = await store.createDocument({ stream: Readable.from([classicPdf()]), displayName: 'batch.pdf', mediaType: 'application/pdf' });
  const service = new PdfIncrementalBatchLinkService({ store, poppler: new PopplerAdapter({ registry, runner }) });
  const result = await service.update(document.id, { profile: 'local-aec-batch-link-v1', links }, { sourceSha256: document.sha256 });
  assert.equal(result.links.length, 2); assert.equal(result.evidence.pageValidationRendersMatched, true); assert.equal(await store.verifySource(document.id), true); await store.deleteArtifact(result.artifact.id);
  const tampered = new PdfIncrementalBatchLinkService({ store, poppler: new PopplerAdapter({ registry, runner }), core: {
    normalizeIncrementalBatchGoToLinks,
    writeIncrementalPdfBatchGoToLinks: (source, request) => { const output = writeIncrementalPdfBatchGoToLinks(source, request); return { ...output, proof: { ...output.proof, links: [] } }; },
    inspectIncrementalPdfBatchGoToLinks,
  } });
  await assert.rejects(tampered.update(document.id, { profile: 'local-aec-batch-link-v1', links }, { sourceSha256: document.sha256 }), { code: 'INCREMENTAL_BATCH_LINK_OUTPUT_INVALID' });
  const sourcePath = store.getSourcePath(document.id); const original = await readFile(sourcePath);
  const proxy = () => Object.fromEntries(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'].map((name) => [name, store[name].bind(store)]));
  const workspaceEntryStore = proxy(); workspaceEntryStore.createJobWorkspace = async (...args) => { const path = await store.createJobWorkspace(...args); await writeFile(join(path, 'unexpected'), 'x', { mode: 0o600 }); return path; };
  await assert.rejects(new PdfIncrementalBatchLinkService({ store: workspaceEntryStore, poppler: new PopplerAdapter({ registry, runner }) }).update(document.id, { profile: 'local-aec-batch-link-v1', links }, { sourceSha256: document.sha256 }), { code: 'INCREMENTAL_BATCH_LINK_WORKSPACE_INVALID' });
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled')); const cancelledStore = proxy(); await assert.rejects(new PdfIncrementalBatchLinkService({ store: cancelledStore, poppler: new PopplerAdapter({ registry, runner }) }).update(document.id, { profile: 'local-aec-batch-link-v1', links }, { sourceSha256: document.sha256, signal: cancelled.signal }), { code: 'JOB_CANCELLED' });
  let verifyCount = 0; const swappedStore = proxy(); swappedStore.verifySource = async (...args) => { const value = await store.verifySource(...args); verifyCount += 1; if (verifyCount === 1) { const changed = Buffer.from(original); changed[changed.length - 1] = changed[changed.length - 1] === 10 ? 11 : 10; await writeFile(sourcePath, changed); } return value; };
  await assert.rejects(new PdfIncrementalBatchLinkService({ store: swappedStore, poppler: new PopplerAdapter({ registry, runner }) }).update(document.id, { profile: 'local-aec-batch-link-v1', links }, { sourceSha256: document.sha256 }), { code: 'INCREMENTAL_BATCH_LINK_FAILED' }); await writeFile(sourcePath, original);
  const cleanupStore = proxy(); const cleanupDeleted = []; cleanupStore.cleanupJob = async (...args) => { await store.cleanupJob(...args); throw new Error('cleanup failed'); }; cleanupStore.deleteArtifact = async (id) => { cleanupDeleted.push(id); await store.deleteArtifact(id); }; const cleanupService = new PdfIncrementalBatchLinkService({ store: cleanupStore, poppler: new PopplerAdapter({ registry, runner }) }); await assert.rejects(cleanupService.update(document.id, { profile: 'local-aec-batch-link-v1', links }, { sourceSha256: document.sha256 }), { code: 'INCREMENTAL_BATCH_LINK_CLEANUP_FAILED' }); assert.equal(cleanupDeleted.length, 1);
});
