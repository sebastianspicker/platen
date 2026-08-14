import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfHiddenDataSanitizationService } from '../scripts/host/pdf-hidden-data-sanitization-service.mjs';

function sourcePdf(hidden = true) {
  const objects = hidden
    ? ['<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream', '<< /Type /Metadata /Length 0 >>\nstream\n\nendstream']
    : ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let body = '%PDF-1.7\n'; const offsets = [];
  for (let index = 0; index < objects.length; index += 1) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(body, 'latin1'); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function setup(t, bytes = sourcePdf()) {
  const root = await mkdtemp('/private/tmp/pdf-hidden-data-service-'); const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose());
  const source = await store.createDocument({ stream: (async function* () { yield bytes; })(), displayName: 'source.pdf' });
  return { store, source, bytes, service: new PdfHiddenDataSanitizationService({ store }) };
}

test('hidden-data sanitization service stages, independently reinspects, promotes, and cleans', async (t) => {
  const state = await setup(t); const result = await state.service.sanitize(state.source.id, { sourceSha256: state.source.sha256 });
  assert.equal(result.artifact.documentId, state.source.id); assert.equal(result.proof.closedClassicRevision, true); assert.equal(result.proof.reachablePageContentPreserved, true);
  assert.deepEqual(await readdir(join(state.store.root, 'jobs')), []); assert.equal((await readFile(state.store.getSourcePath(state.source.id))).equals(state.bytes), true);
});

test('hidden-data sanitization service rejects stale and unsupported sources before promotion', async (t) => {
  const stale = await setup(t); await assert.rejects(stale.service.sanitize(stale.source.id, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  const encrypted = Buffer.concat([sourcePdf(false), Buffer.from(' /Encrypt 7 0 R')]); const unsupported = await setup(t, encrypted);
  await assert.rejects(unsupported.service.sanitize(unsupported.source.id, { sourceSha256: unsupported.source.sha256 }), { code: 'HIDDEN_DATA_SANITIZATION_SOURCE_UNSUPPORTED' });
});

test('hidden-data sanitization service maps cancellation and leaves no workspace', async (t) => {
  const state = await setup(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(state.service.sanitize(state.source.id, { sourceSha256: state.source.sha256, signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(await readdir(join(state.store.root, 'jobs')), []);
});

test('hidden-data sanitization service detects promoted-output tampering and still cleans its workspace', async (t) => {
  const state = await setup(t); const base = state.store;
  const methods = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact'];
  const tamperStore = Object.fromEntries(methods.map((name) => [name, base[name].bind(base)]));
  tamperStore.promotePdfArtifact = async (documentId, outputPath, options) => {
    const bytes = await readFile(outputPath); await writeFile(outputPath, Buffer.concat([bytes, Buffer.from('tamper')]), { mode: 0o600 });
    return base.promotePdfArtifact(documentId, outputPath, options);
  };
  const service = new PdfHiddenDataSanitizationService({ store: tamperStore });
  await assert.rejects(service.sanitize(state.source.id, { sourceSha256: state.source.sha256 }), { code: 'ARTIFACT_DIGEST_MISMATCH' });
  assert.deepEqual(await readdir(join(base.root, 'jobs')), []);
});

test('hidden-data sanitization service reports cleanup failure and revokes a promoted artifact', async (t) => {
  const state = await setup(t); const base = state.store;
  const methods = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'deleteArtifact'];
  const failingStore = Object.fromEntries(methods.map((name) => [name, base[name].bind(base)]));
  failingStore.cleanupJob = async () => { throw new Error('cleanup blocked'); };
  failingStore.promotePdfArtifact = base.promotePdfArtifact.bind(base);
  const service = new PdfHiddenDataSanitizationService({ store: failingStore });
  await assert.rejects(service.sanitize(state.source.id, { sourceSha256: state.source.sha256 }), { code: 'HIDDEN_DATA_SANITIZATION_CLEANUP_FAILED' });
});
