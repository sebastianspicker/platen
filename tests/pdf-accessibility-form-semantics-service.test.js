import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAccessibilityFormSemanticsService } from '../scripts/host/pdf-accessibility-form-semantics-service.mjs';
import { makeButtonWidgetPdf } from './host-pdfkit-test-fixtures-b.js';
const PROFILE = 'local-accessibility-form-semantics-v1';
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(bytes) {
  const sourceSha256 = digest(bytes);
  return { profile: PROFILE, sourceSha256, fields: [0, 1, 2].map((annotationIndex, tabIndex) => ({
    target: { page: 1, annotationIndex, fingerprint: digest(Buffer.from([
      'pdfkit-inspector:opaque-locator:v1', `source-sha256=${sourceSha256}`,
      'page=1', `annotation-index=${annotationIndex}`, 'subtype=widget', 'widget-type=button',
    ].join('\n'))) }, role: 'button', name: `Field ${annotationIndex}`,
    tooltip: `Field tooltip ${annotationIndex}`, tabIndex,
  })) };
}
async function setup(t) {
  const root = await mkdtemp('/private/tmp/pdf-accessibility-form-semantics-');
  const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose());
  const bytes = makeButtonWidgetPdf();
  const source = await store.createDocument({ stream: (async function* () { yield bytes; }()), displayName: 'source.pdf' });
  return { root, store, bytes, source, request: request(bytes), service: new PdfAccessibilityFormSemanticsService({ store }) };
}
test('service promotes an independently inspected append-only accessible form artifact and cleans workspace', async (t) => {
  const state = await setup(t); const result = await state.service.repair(state.source.id, state.request);
  assert.equal(result.kind, 'pdf-accessibility-form-semantics'); assert.equal(result.proof.tabOrder, 'S');
  assert.notEqual(result.artifact.sha256, state.source.sha256); assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
  assert.deepEqual(await readFile(state.store.getSourcePath(state.source.id)), state.bytes);
});
test('service rejects stale source, cancellation, and promotion drift', async (t) => {
  const state = await setup(t);
  await assert.rejects(state.service.repair(state.source.id, { ...state.request, sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(state.service.repair(state.source.id, state.request, { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  const base = state.store; const wrapped = {};
  for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact']) wrapped[name] = base[name].bind(base);
  wrapped.promotePdfArtifact = async (...args) => {
    const [documentId, path, options] = args; await chmod(path, 0o600);
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('tamper')]));
    return base.promotePdfArtifact(documentId, path, options);
  };
  await assert.rejects(new PdfAccessibilityFormSemanticsService({ store: wrapped }).repair(state.source.id, state.request), { code: 'ARTIFACT_DIGEST_MISMATCH' });
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
  const drift = await setup(t); let verifies = 0; const driftStore = {};
  for (const name of ['getDocument', 'getSourcePath', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']) driftStore[name] = drift.store[name].bind(drift.store);
  driftStore.verifySource = async (...args) => {
    verifies += 1;
    if (verifies === 3) { const path = drift.store.getSourcePath(drift.source.id); await chmod(path, 0o600); await writeFile(path, Buffer.concat([drift.bytes, Buffer.from('drift')])); }
    return drift.store.verifySource(...args);
  };
  await assert.rejects(new PdfAccessibilityFormSemanticsService({ store: driftStore }).repair(drift.source.id, drift.request), { code: 'SOURCE_INTEGRITY_FAILED' });
});
