import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAccessibilityTableSemanticsService } from '../scripts/host/pdf-accessibility-table-semantics-service.mjs';
import { makeTablePdf, tableRequest } from './host-pdf-table-semantics-fixtures.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-accessibility-table-semantics-')); const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose());
  const bytes = makeTablePdf(); const source = await store.createDocument({ stream: (async function* () { yield bytes; }()), displayName: 'source.pdf' });
  return { root, store, bytes, source, request: tableRequest(bytes), service: new PdfAccessibilityTableSemanticsService({ store }) };
}
function wrappedStore(base, overrides = {}) { const store = {}; for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'getArtifact', 'deleteArtifact']) store[name] = (overrides[name] ?? base[name]).bind(base); return store; }

test('service promotes a verified table artifact and removes its private workspace', async (t) => {
  const state = await setup(t); const result = await state.service.repair(state.source.id, state.request);
  assert.equal(result.kind, 'pdf-accessibility-table-semantics'); assert.equal(result.artifact.mediaType, 'application/pdf'); assert.ok(result.artifact.size > state.bytes.length); assert.equal(state.store.getArtifact(result.artifact.id).sha256, result.artifact.sha256);
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []); await state.store.deleteArtifact(result.artifact.id);
});

test('service rejects forged promotion without deleting an unrelated artifact', async (t) => {
  const state = await setup(t); const deleted = []; const forged = { id: randomUUID(), documentId: state.source.id, displayName: 'accessible-table-semantics.pdf', mediaType: 'application/pdf', size: 1, sha256: '0'.repeat(64), operation: {} };
  const store = wrappedStore(state.store, { promotePdfArtifact: async () => forged, deleteArtifact: async (id) => { deleted.push(id); } });
  await assert.rejects(new PdfAccessibilityTableSemanticsService({ store }).repair(state.source.id, state.request), { code: 'PDF_ACCESSIBILITY_TABLE_SEMANTICS_OUTPUT_INVALID' }); assert.deepEqual(deleted, []); assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});

test('service revokes a promoted artifact after cancellation or source drift', async (t) => {
  const state = await setup(t); const controller = new AbortController(); const base = state.store; let promoted;
  const store = wrappedStore(base, { promotePdfArtifact: async (...args) => { promoted = await base.promotePdfArtifact(...args); controller.abort(); return promoted; } });
  await assert.rejects(new PdfAccessibilityTableSemanticsService({ store }).repair(state.source.id, state.request, { signal: controller.signal }), { code: 'JOB_CANCELLED' }); assert.throws(() => state.store.getArtifact(promoted.id), { code: 'ARTIFACT_NOT_FOUND' });
  const drift = await setup(t); let verifies = 0; const driftStore = wrappedStore(drift.store, { verifySource: async (...args) => { verifies += 1; if (verifies === 3) { const path = drift.store.getSourcePath(drift.source.id); await chmod(path, 0o600); await writeFile(path, Buffer.concat([drift.bytes, Buffer.from('drift')])); } return drift.store.verifySource(...args); } });
  await assert.rejects(new PdfAccessibilityTableSemanticsService({ store: driftStore }).repair(drift.source.id, drift.request), { code: 'SOURCE_INTEGRITY_FAILED' }); assert.deepEqual(await readdir(join(drift.root, 'jobs')), []);
});

test('service reports workspace and artifact revocation failures together', async (t) => {
  const state = await setup(t); const controller = new AbortController(); const base = state.store;
  const store = wrappedStore(base, { promotePdfArtifact: async (...args) => { const artifact = await base.promotePdfArtifact(...args); controller.abort(); return artifact; }, cleanupJob: async () => { throw new Error('workspace cleanup failed'); }, deleteArtifact: async () => { throw new Error('artifact revoke failed'); } });
  await assert.rejects(new PdfAccessibilityTableSemanticsService({ store }).repair(state.source.id, state.request, { signal: controller.signal }), { code: 'PDF_ACCESSIBILITY_TABLE_SEMANTICS_CLEANUP_FAILED' });
});
