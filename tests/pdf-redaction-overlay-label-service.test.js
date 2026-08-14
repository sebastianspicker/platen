import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { redactionFixture } from '../scripts/host/professional-capability/fixtures.mjs';
import { PdfRedactionOverlayLabelService } from '../scripts/host/pdf-redaction-overlay-label-service.mjs';
import { HostError } from '../scripts/host/host-error.mjs';
import { REDACTION_OVERLAY_LABEL_PROFILE } from '../src/core/pdf-redaction-overlay-label-contract.js';
import { writeFullPageRedaction } from '../scripts/host/pdf-full-page-redaction-writer.mjs';
import { writeInertPageAnnotation } from '../scripts/host/professional-capability/inert-annotation-writer.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function setup(t, hooks = {}) {
  const root = await mkdtemp('/tmp/platen-overlay-');
  const source = redactionFixture({ secret: 'secret', survivor: 'survivor' });
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, source, { mode: 0o600 });
  const sha256 = digest(source);
  const state = { verify: 0, deleted: [], workspaces: [] };
  const store = {
    getDocument: () => ({ id, sha256, size: source.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => { state.verify += 1; if (hooks.verifySource) await hooks.verifySource(state); },
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); state.workspaces.push(path); return path; },
    cleanupJob: async (path) => { if (hooks.cleanupJob) await hooks.cleanupJob(path); await rm(path, { recursive: true, force: true }); },
    promotePdfArtifact: async (documentId, path, options) => {
      const bytes = await readFile(path);
      if (hooks.promotePdfArtifact) return hooks.promotePdfArtifact({ documentId, path, options, bytes, state });
      return { id: '22222222-2222-4222-8222-222222222222', documentId, mediaType: 'application/pdf', size: bytes.length, sha256: digest(bytes), displayName: options.displayName, operation: options.operation, createdAt: new Date().toISOString() };
    },
    deleteArtifact: async (artifactId) => { state.deleted.push(artifactId); if (hooks.deleteArtifact) await hooks.deleteArtifact(artifactId); },
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { source, sha256, store, state, request: { profile: REDACTION_OVERLAY_LABEL_PROFILE, sourceSha256: sha256, page: 1, label: 'PUBLIC' } };
}

test('overlay-label service produces one source-bound artifact without PDF bytes', async (t) => {
  const state = await setup(t);
  const result = await new PdfRedactionOverlayLabelService({ store: state.store }).apply(id, state.request);
  assert.equal(result.kind, 'pdf-redaction-overlay-label');
  assert.equal(result.label, 'PUBLIC');
  assert.equal(result.artifact.documentId, id);
  assert.equal(result.artifact.id === id, false);
  assert.deepEqual(Object.values(result.evidence), Array(8).fill(true));
  assert.equal('pdf' in result, false);
  assert.equal('bytes' in result, false);
});

test('overlay-label service rejects source digest drift and cleans its workspace', async (t) => {
  const state = await setup(t, { verifySource: async (runtime) => {
    if (runtime.verify === 2) {
      await writeFile(state.store.getSourcePath(id), Buffer.concat([state.source, Buffer.from('drift')]));
      throw new HostError('SOURCE_INTEGRITY_FAILED', 'source drift');
    }
  } });
  await assert.rejects(new PdfRedactionOverlayLabelService({ store: state.store }).apply(id, state.request), { code: 'SOURCE_INTEGRITY_FAILED' });
  assert.deepEqual(state.state.deleted, []);
});

test('overlay-label service validates the raw writer proof', async (t) => {
  const state = await setup(t);
  const badWriter = () => ({ bytes: Buffer.from('%PDF-1.7\n%%EOF\n'), proof: { sourcePrefixPreserved: true } });
  await assert.rejects(new PdfRedactionOverlayLabelService({ store: state.store, redactionWriter: badWriter }).apply(id, state.request), { code: 'REDACTION_OVERLAY_LABEL_OUTPUT_INVALID' });
});

test('overlay-label service freezes writer requests and keeps private paths out of the result', async (t) => {
  const state = await setup(t);
  let redactionFrozen = false; let annotationFrozen = false;
  const service = new PdfRedactionOverlayLabelService({
    store: state.store,
    redactionWriter: (bytes, request) => { redactionFrozen = Object.isFrozen(request); return writeFullPageRedaction(bytes, request); },
    annotationWriter: (bytes, request) => { annotationFrozen = Object.isFrozen(request) && Object.isFrozen(request.rect); return writeInertPageAnnotation(bytes, request); },
  });
  const result = await service.apply(id, state.request);
  assert.equal(redactionFrozen, true);
  assert.equal(annotationFrozen, true);
  assert.equal(JSON.stringify(result).includes('/tmp/'), false);
});

test('overlay-label service enforces bounded input and cancellation cleanup', async (t) => {
  const state = await setup(t);
  state.store.getDocument = () => ({ id, sha256: state.sha256, size: 128 * 1024 * 1024 + 1, displayName: 'source.pdf' });
  await assert.rejects(new PdfRedactionOverlayLabelService({ store: state.store }).apply(id, state.request), { code: 'REDACTION_OVERLAY_LABEL_INPUT_TOO_LARGE' });

  const cancelled = await setup(t);
  const controller = new AbortController();
  cancelled.store.promotePdfArtifact = async (...args) => { const artifact = await setupPromote(cancelled, ...args); controller.abort(); return artifact; };
  await assert.rejects(new PdfRedactionOverlayLabelService({ store: cancelled.store }).apply(id, cancelled.request, { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.equal(cancelled.state.deleted.length, 1);
});

async function setupPromote(state, documentId, path, options) {
  const bytes = await readFile(path);
  return { id: '33333333-3333-4333-8333-333333333333', documentId, mediaType: 'application/pdf', size: bytes.length, sha256: digest(bytes), displayName: options.displayName, operation: options.operation, createdAt: new Date().toISOString() };
}
