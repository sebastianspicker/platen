import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';
import { makeTextPdf } from './pdf-fixture.js';
import { PdfTextEditService } from '../scripts/host/pdf-text-edit-service.mjs';

const execFileAsync = promisify(execFile);

const documentId = '11111111-1111-4111-8111-111111111111';
const request = Object.freeze({ profile: 'local-pdf-text-edit-v1', page: 1, find: 'hello world', replace: 'HELLO WORLD' });

async function fixture({ outputText = 'HELLO WORLD', cleanupFailure = false, revokeFailure = false, badPromotion = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-text-edit-service-'));
  const sourceBytes = makeTextPdf('hello world'); const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const calls = { cleanup: 0, promoted: 0, deleted: 0 };
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha256, size: sourceBytes.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => {},
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; },
    cleanupJob: async (path) => { calls.cleanup += 1; if (cleanupFailure) throw new Error('cleanup refused'); await rm(path, { recursive: true, force: true }); },
    promotePdfArtifact: async (_id, path, options) => {
      calls.promoted += 1; const bytes = await readFile(path); assert.equal(createHash('sha256').update(bytes).digest('hex'), options.expectedSha256);
      return { id: '22222222-2222-4222-8222-222222222222', sha256: badPromotion ? 'a'.repeat(64) : options.expectedSha256, operation: options.operation };
    },
    deleteArtifact: async () => { calls.deleted += 1; if (revokeFailure) throw new Error('revoke refused'); },
  };
  const poppler = { execute: async (_operation, parameters) => ({ stdout: parameters.input.endsWith('output.pdf') ? `${outputText}\f` : 'hello world\f', stderr: '' }) };
  return { root, sourceSha256, calls, store, poppler, service: new PdfTextEditService({ store, poppler }) };
}

test('text-edit service binds the source digest before opening a workspace', async () => {
  const f = await fixture();
  try { await assert.rejects(f.service.edit(documentId, request, { sourceSha256: 'a'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' }); assert.equal(f.calls.cleanup, 0); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('text-edit service validates Poppler exact-change evidence before promotion', async () => {
  const f = await fixture({ outputText: 'unrelated' });
  try { await assert.rejects(f.service.edit(documentId, request, { sourceSha256: f.sourceSha256 }), { code: 'PDF_TEXT_EDIT_OUTPUT_INVALID' }); assert.equal(f.calls.promoted, 0); assert.equal(f.calls.cleanup, 1); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('text-edit service honors cancellation before mutation', async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort(new Error('cancelled'));
  try { await assert.rejects(f.service.edit(documentId, request, { sourceSha256: f.sourceSha256, signal: controller.signal }), { code: 'JOB_CANCELLED' }); assert.equal(f.calls.promoted, 0); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('text-edit service revokes an artifact when promotion validation fails', async () => {
  const f = await fixture({ badPromotion: true });
  try { await assert.rejects(f.service.edit(documentId, request, { sourceSha256: f.sourceSha256 }), { code: 'PDF_TEXT_EDIT_OUTPUT_INVALID' }); assert.equal(f.calls.promoted, 1); assert.equal(f.calls.deleted, 1); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('text-edit service aggregates workspace cleanup and artifact revocation failures', async () => {
  const f = await fixture({ cleanupFailure: true, revokeFailure: true });
  try { await assert.rejects(f.service.edit(documentId, request, { sourceSha256: f.sourceSha256 }), { code: 'PDF_TEXT_EDIT_CLEANUP_FAILED' }); assert.equal(f.calls.promoted, 1); assert.equal(f.calls.deleted, 1); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('text-edit service retains a validated artifact after successful cleanup', async () => {
  const f = await fixture();
  try { const result = await f.service.edit(documentId, request, { sourceSha256: f.sourceSha256 }); assert.equal(result.kind, 'pdf-text-edit'); assert.equal(f.calls.promoted, 1); assert.equal(f.calls.deleted, 0); assert.equal(f.calls.cleanup, 1); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('text-edit service validates the installed Poppler text surface when available', { skip: spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).error !== undefined }, async () => {
  const f = await fixture();
  const poppler = { execute: async (_operation, parameters) => {
    const result = await execFileAsync('pdftotext', ['-layout', parameters.input, '-']);
    return { stdout: result.stdout, stderr: result.stderr ?? '' };
  } };
  try { const service = new PdfTextEditService({ store: f.store, poppler }); const result = await service.edit(documentId, request, { sourceSha256: f.sourceSha256 }); assert.equal(result.kind, 'pdf-text-edit'); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});
