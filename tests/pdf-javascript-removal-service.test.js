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
import { PdfJavaScriptRemovalService } from '../scripts/host/pdf-javascript-removal-service.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const request = Object.freeze({ profile: 'local-document-javascript-removal-v1' });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function proof(source, output, changes = {}) { return Object.freeze({ profile: request.profile, sourceBytes: source.length, outputBytes: output.length, sourceSha256: sha(source), outputSha256: sha(output), removedLocus: 'open-action', removedObjectCount: 1, closedClassicRevision: true, priorRevisionsAbsent: true, javascriptSurfacesAbsent: true, removedReferencesUnresolvable: true, rootPreserved: true, infoPreserved: true, idPolicy: 'absent', ...changes }); }

async function fixture(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'javascript-removal-service-')); context.after(() => rm(root, { recursive: true, force: true }));
  const source = Buffer.from(`%PDF-1.7\n${'javascript source '.repeat(12)}\n%%EOF\n`); const output = Buffer.from(`%PDF-1.7\n${'javascript removed '.repeat(12)}\n%%EOF\n`); const digest = sha(source); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  const observed = { promoted: 0, deleted: [], workspaces: [], outputSwapped: false }; const controller = options.controller ?? new AbortController();
  const store = {
    getDocument: () => ({ id: documentId, sha256: digest, size: source.length, displayName: 'source.pdf' }), getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(sha(await readFile(sourcePath)), digest),
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); observed.workspaces.push(path); return path; },
    cleanupJob: async (path) => { await rm(path, { recursive: true, force: true }); if (options.cleanupFailure) throw new Error('cleanup failure'); },
    promotePdfArtifact: async (_id, _path, promotion) => { observed.promoted += 1; if (options.abortAfterPromotion) controller.abort(new Error('after promotion')); return { id: '22222222-2222-4222-8222-222222222222', sha256: options.promotedDigest ?? promotion.expectedSha256, operation: promotion.operation }; },
    deleteArtifact: async (id) => { observed.deleted.push(id); if (options.deleteFailure) throw new Error('delete failure'); },
  };
  const info = (javascript, mismatch = false) => `Pages: 1\n${mismatch ? 'Title: changed\n' : ''}Encrypted: no\nForm: none\nJavaScript: ${javascript}\n`;
  const poppler = { execute: async (operation, parameters) => {
    const outputFile = String(parameters.input ?? '').endsWith('output.pdf');
    if (operation === 'inspect') return { stdout: info(outputFile ? 'no' : 'yes', outputFile && options.envelopeMismatch), stderr: options.warning && outputFile ? 'warning' : '' };
    if (['inspectMetadata', 'inspectCustomMetadata'].includes(operation)) return { stdout: '', stderr: '' };
    if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' };
    if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
    if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
    if (operation === 'inspectPageBoxes') return { stdout: options.contentMismatch && outputFile ? 'Page 1 size: 101 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 101 100\nPage 1 CropBox: 0 0 101 100\n' : 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\n', stderr: options.contentWarning && outputFile ? 'warning' : '' };
    if (operation === 'extractText') return { stdout: options.contentMismatch && outputFile ? 'changed\f' : 'fixture\f', stderr: '' };
    if (operation === 'renderPagePng') { if (options.swapOutput && outputFile && !observed.outputSwapped) { await unlink(parameters.input); await writeFile(parameters.input, output, { mode: 0o400 }); observed.outputSwapped = true; } await writeFile(`${parameters.outputPrefix}.png`, options.renderMismatch && outputFile ? Buffer.concat([png, Buffer.from('x')]) : png); return { stdout: '', stderr: options.renderWarning && outputFile ? 'warning' : '' }; }
    assert.fail(operation);
  } };
  const exact = proof(source, output); const core = { normalizePdfJavaScriptRemoval: (value) => value, writePdfJavaScriptRemoval: (input) => options.overlap ? { bytes: input, proof: exact } : { bytes: Buffer.from(output), proof: options.proofDigestMismatch ? proof(source, output, { outputSha256: '0'.repeat(64) }) : exact }, inspectPdfJavaScriptRemoval: (_input, bytes) => options.inspectorMismatch ? proof(source, bytes, { removedLocus: 'names', removedObjectCount: 2 }) : options.tamperedInspector ? proof(source, bytes, { outputSha256: 'f'.repeat(64) }) : exact };
  return { service: new PdfJavaScriptRemovalService({ store, poppler, core }), digest, source, output, observed, controller };
}

test('JavaScript-removal service stages, reinspects, renders, and promotes only a verified compact output', async (context) => {
  const setup = await fixture(context); const result = await setup.service.remove(documentId, request, { sourceSha256: setup.digest });
  assert.equal(setup.observed.promoted, 1); assert.equal(result.kind, 'pdf-javascript-removal'); assert.deepEqual(result.removal, { profile: request.profile, removedLocus: 'open-action' }); assert.equal(result.evidence.javascriptSurfacesAbsent, true); assert.deepEqual(setup.observed.deleted, []); await Promise.all(setup.observed.workspaces.map((path) => assert.rejects(readFile(path))));
});

test('JavaScript-removal service rejects stale, overlap, proof, inspection, identity, warning, and Poppler-equivalence failures without promotion', async (context) => {
  const stale = await fixture(context); await assert.rejects(stale.service.remove(documentId, request, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' }); assert.equal(stale.observed.workspaces.length, 0);
  for (const [options, code] of [[{ overlap: true }, 'PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID'], [{ proofDigestMismatch: true }, 'PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID'], [{ inspectorMismatch: true }, 'PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID'], [{ tamperedInspector: true }, 'PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID'], [{ swapOutput: true }, 'PDF_JAVASCRIPT_REMOVAL_WORKSPACE_INVALID'], [{ warning: true }, 'PDF_JAVASCRIPT_REMOVAL_POPPLER_WARNING'], [{ contentWarning: true }, 'PDF_JAVASCRIPT_REMOVAL_POPPLER_WARNING'], [{ renderWarning: true }, 'PDF_JAVASCRIPT_REMOVAL_POPPLER_WARNING'], [{ envelopeMismatch: true }, 'PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID'], [{ contentMismatch: true }, 'PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID'], [{ renderMismatch: true }, 'PDF_JAVASCRIPT_REMOVAL_OUTPUT_INVALID']]) {
    const setup = await fixture(context, options); await assert.rejects(setup.service.remove(documentId, request, { sourceSha256: setup.digest }), { code }); assert.equal(setup.observed.promoted, 0); assert.deepEqual(setup.observed.deleted, []);
  }
});

test('JavaScript-removal service revokes a promoted artifact after cancellation or cleanup failure', async (context) => {
  const cancelled = await fixture(context, { abortAfterPromotion: true }); await assert.rejects(cancelled.service.remove(documentId, request, { sourceSha256: cancelled.digest, signal: cancelled.controller.signal }), { code: 'JOB_CANCELLED' }); assert.deepEqual(cancelled.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
  const cleanup = await fixture(context, { cleanupFailure: true }); await assert.rejects(cleanup.service.remove(documentId, request, { sourceSha256: cleanup.digest }), { code: 'PDF_JAVASCRIPT_REMOVAL_CLEANUP_FAILED' }); assert.deepEqual(cleanup.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
});

function javascriptPdf() {
  const values = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources <<>> >>',
    '<< /S /JavaScript /JS (app.alert\\(\"fixture\"\\)) >>',
  ];
  const chunks = ['%PDF-1.7\n']; const offsets = [];
  values.forEach((value, index) => { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${value}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 5\n0000000000 65535 f \n'); offsets.forEach((offset) => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`)); chunks.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(chunks.join(''), 'latin1');
}

test('installed Poppler service publishes a verified compact JavaScript-free artifact', { timeout: 30_000 }, async (context) => {
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 }); const registry = new EngineRegistry({ runner }); const required = ['pdfinfo', 'pdftotext', 'pdftocairo', 'pdfdetach', 'pdfsig'];
  if ((await Promise.allSettled(required.map((name) => registry.probe(name)))).some(({ status }) => status === 'rejected')) { context.skip('Required Poppler tools are unavailable.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'javascript-removal-service-poppler-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  const document = await store.createDocument({ stream: Readable.from([javascriptPdf()]), displayName: 'javascript.pdf', mediaType: 'application/pdf' }); const service = new PdfJavaScriptRemovalService({ store, poppler: new PopplerAdapter({ registry, runner }) });
  const result = await service.remove(document.id, request, { sourceSha256: document.sha256 }); assert.notEqual(result.artifact.sha256, document.sha256); assert.equal(result.evidence.javascriptSurfacesAbsent, true); assert.equal(await store.verifySource(document.id), true);
});
