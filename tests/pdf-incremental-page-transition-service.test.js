import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  INCREMENTAL_PAGE_TRANSITION_PROFILE,
  normalizeIncrementalPageTransition,
} from '../scripts/host/pdf-incremental-page-transition-contract.mjs';
import {
  PdfIncrementalPageTransitionService,
} from '../scripts/host/pdf-incremental-page-transition-service.mjs';
import {
  inspectIncrementalPdfPageTransition,
  writeIncrementalPdfPageTransition,
} from '../scripts/host/pdf-incremental-page-transition-writer.mjs';
import { validateIncrementalPageTransitionResult } from '../src/core/pdf-incremental-page-transition-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const request = Object.freeze({ profile: INCREMENTAL_PAGE_TRANSITION_PROFILE, pages: Object.freeze([1]), transition: 'Dissolve', duration: 2 });

function sourcePdf() {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Contents 4 0 R >>',
    '<< /Length 3 >>\nstream\nabc\nendstream',
  ];
  const chunks = ['%PDF-1.7\n']; const offsets = [];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 5\n0000000000 65535 f \n');
  offsets.forEach((offset) => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

async function makeFixture({ abortAfterPromotion = false, cleanupFailure = false, tamper = false, tamperProof = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'page-transition-service-')); const source = sourcePdf();
  const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  const sourceSha256 = createHash('sha256').update(source).digest('hex'); const controller = new AbortController();
  const calls = { write: 0, inspect: 0, verify: 0, clean: 0, deleted: null };
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha256, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => { calls.verify += 1; assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha256); },
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; },
    cleanupJob: async (path) => { calls.clean += 1; if (cleanupFailure) throw new Error('cleanup refused'); await rm(path, { recursive: true, force: true }); },
    promotePdfArtifact: async (_id, path, options) => {
      const bytes = await readFile(path); assert.equal(createHash('sha256').update(bytes).digest('hex'), options.expectedSha256);
      const artifact = { id: '22222222-2222-4222-8222-222222222222', documentId, displayName: options.displayName, mediaType: 'application/pdf', size: bytes.length, sha256: options.expectedSha256, operation: options.operation, createdAt: '2026-07-21T12:00:00.000Z' };
      if (abortAfterPromotion) controller.abort(new Error('cancel after promotion'));
      return artifact;
    },
    deleteArtifact: async (id) => { calls.deleted = id; },
  };
  const core = {
    normalizeIncrementalPageTransition,
    writeIncrementalPdfPageTransition: (bytes, value) => { calls.write += 1; const result = writeIncrementalPdfPageTransition(bytes, value); if (tamper) result.bytes[result.bytes.length - 12] ^= 1; if (tamperProof) return { ...result, proof: { ...result.proof, duration: 3 } }; return result; },
    inspectIncrementalPdfPageTransition: (sourceBytes, outputBytes, value) => { calls.inspect += 1; return inspectIncrementalPdfPageTransition(sourceBytes, outputBytes, value); },
  };
  return { root, sourceSha256, controller, calls, service: new PdfIncrementalPageTransitionService({ store, core }) };
}

test('service re-inspects and promotes a source-bound page-transition artifact', async (context) => {
  const fixture = await makeFixture(); context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await fixture.service.update(documentId, request, { sourceSha256: fixture.sourceSha256 });
  assert.equal(result.kind, 'pdf-incremental-page-transition');
  assert.equal(result.artifact.sha256 !== fixture.sourceSha256, true);
  assert.deepEqual(result.transition, { pages: [1], style: 'Dissolve', duration: 2 });
  assert.equal(result.evidence.pageTopologyPreserved, true);
  validateIncrementalPageTransitionResult(JSON.parse(JSON.stringify(result)), { documentId, sourceSha256: fixture.sourceSha256, request });
  assert.equal(fixture.calls.write, 1); assert.equal(fixture.calls.inspect, 2); assert.equal(fixture.calls.verify, 2); assert.equal(fixture.calls.clean, 1);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.transition), true);
});

test('service rejects wrong source digest and rolls back promotion on cancellation', async (context) => {
  const wrong = await makeFixture(); context.after(() => rm(wrong.root, { recursive: true, force: true }));
  await assert.rejects(wrong.service.update(documentId, request, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  const cancelled = await makeFixture({ abortAfterPromotion: true }); context.after(() => rm(cancelled.root, { recursive: true, force: true }));
  await assert.rejects(cancelled.service.update(documentId, request, { sourceSha256: cancelled.sourceSha256, signal: cancelled.controller.signal }), { code: 'JOB_CANCELLED' });
  assert.equal(cancelled.calls.deleted, '22222222-2222-4222-8222-222222222222');
});

test('service fails closed on writer tampering and cleanup failure', async (context) => {
  const tampered = await makeFixture({ tamper: true }); context.after(() => rm(tampered.root, { recursive: true, force: true }));
  await assert.rejects(tampered.service.update(documentId, request, { sourceSha256: tampered.sourceSha256 }), { code: 'INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID' });
  const proofTampered = await makeFixture({ tamperProof: true }); context.after(() => rm(proofTampered.root, { recursive: true, force: true }));
  await assert.rejects(proofTampered.service.update(documentId, request, { sourceSha256: proofTampered.sourceSha256 }), { code: 'INCREMENTAL_PAGE_TRANSITION_OUTPUT_INVALID' });
  const cleanup = await makeFixture({ cleanupFailure: true }); context.after(() => rm(cleanup.root, { recursive: true, force: true }));
  await assert.rejects(cleanup.service.update(documentId, request, { sourceSha256: cleanup.sourceSha256 }), { code: 'INCREMENTAL_PAGE_TRANSITION_CLEANUP_FAILED' });
});
