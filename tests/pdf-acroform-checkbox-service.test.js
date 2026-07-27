import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormCheckboxService } from '../scripts/host/pdf-acroform-checkbox-service.mjs';

function sourcePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream']; let body = '%PDF-1.7\n'; const offsets = [];
  for (let index = 0; index < objects.length; index += 1) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(body, 'latin1'); body += `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(body, 'latin1');
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(source, extra = {}) { return { profile: 'local-pdf-acroform-checkbox-v1', sourceSha256: digest(source), page: 1, fieldName: 'Approval', rect: { x: 72, y: 700, width: 24, height: 24 }, ...extra }; }
async function setup(t) { const root = await mkdtemp('/private/tmp/pdf-acroform-checkbox-service-'); const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose()); const bytes = sourcePdf(); const source = await store.createDocument({ stream: (async function* () { yield bytes; })(), displayName: 'source.pdf' }); return { store, source, bytes, service: new PdfAcroFormCheckboxService({ store }) }; }

test('AcroForm checkbox service stages, independently reinspects, promotes, and cleans', async (t) => {
  const state = await setup(t); const result = await state.service.add(state.source.id, request(state.bytes));
  assert.equal(result.artifact.documentId, state.source.id); assert.equal(result.proof.otherPagesContentResourcesPreserved, true); assert.equal(result.proof.stateName, 'Yes'); assert.deepEqual(await readdir(join(state.store.root, 'jobs')), []); assert.equal((await readFile(state.store.getSourcePath(state.source.id))).equals(state.bytes), true); assert.equal(result.artifact.operation.expected.unchecked, true);
});

test('AcroForm checkbox service snapshots requests and maps stale or unsupported sources', async (t) => {
  const state = await setup(t); const original = request(state.bytes); const base = state.store; const methods = ['getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']; const wrapped = Object.fromEntries(methods.map((name) => [name, base[name].bind(base)])); wrapped.getDocument = () => { original.fieldName = 'Mutated'; return base.getDocument(state.source.id); }; const service = new PdfAcroFormCheckboxService({ store: wrapped }); const result = await service.add(state.source.id, original); assert.equal(result.proof.fieldNameSha256, digest(Buffer.from('Approval')));
  await assert.rejects(state.service.add(state.source.id, request(state.bytes, { sourceSha256: '0'.repeat(64) })), { code: 'SOURCE_VERSION_MISMATCH' });
  const unsupported = await setup(t); const encrypted = Buffer.concat([unsupported.bytes, Buffer.from('/Encrypt 7 0 R')]); await unsupported.store.deleteDocument(unsupported.source.id); const encryptedSource = await unsupported.store.createDocument({ stream: (async function* () { yield encrypted; })(), displayName: 'encrypted.pdf' }); await assert.rejects(unsupported.service.add(encryptedSource.id, request(encrypted)), { code: 'ACROFORM_CHECKBOX_SOURCE_UNSUPPORTED' });
  const getter = request(state.bytes); Object.defineProperty(getter, 'fieldName', { get() { throw new Error('getter'); }, enumerable: true }); await assert.rejects(state.service.add(state.source.id, getter), { code: 'INVALID_ACROFORM_CHECKBOX_OPTIONS' });
  const symbol = request(state.bytes); symbol[Symbol('extra')] = true; await assert.rejects(state.service.add(state.source.id, symbol), { code: 'INVALID_ACROFORM_CHECKBOX_OPTIONS' });
  const hidden = request(state.bytes); Object.defineProperty(hidden, 'extra', { value: true, enumerable: false }); await assert.rejects(state.service.add(state.source.id, hidden), { code: 'INVALID_ACROFORM_CHECKBOX_OPTIONS' });
});

test('AcroForm checkbox service maps output replacement and cleanup failures', async (t) => {
  const state = await setup(t); const base = state.store; const methods = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact']; const tamperStore = Object.fromEntries(methods.map((name) => [name, base[name].bind(base)])); tamperStore.promotePdfArtifact = async (documentId, outputPath, options) => { const bytes = await readFile(outputPath); await writeFile(outputPath, Buffer.concat([bytes, Buffer.from('tamper')]), { mode: 0o600 }); return base.promotePdfArtifact(documentId, outputPath, options); }; const service = new PdfAcroFormCheckboxService({ store: tamperStore }); await assert.rejects(service.add(state.source.id, request(state.bytes)), { code: 'ARTIFACT_DIGEST_MISMATCH' }); assert.deepEqual(await readdir(join(base.root, 'jobs')), []);
  const cleanup = await setup(t); const cleanupBase = cleanup.store; const cleanupMethods = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'promotePdfArtifact', 'deleteArtifact']; const failingStore = Object.fromEntries(cleanupMethods.map((name) => [name, cleanupBase[name].bind(cleanupBase)])); failingStore.cleanupJob = async () => { throw new Error('blocked'); }; const cleanupService = new PdfAcroFormCheckboxService({ store: failingStore }); await assert.rejects(cleanupService.add(cleanup.source.id, request(cleanup.bytes)), { code: 'ACROFORM_CHECKBOX_CLEANUP_FAILED' });

  const mode = await setup(t); const modeBase = mode.store; let modeWorkspace; let verifyCount = 0; const modeMethods = ['getDocument', 'getSourcePath', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']; const modeStore = Object.fromEntries(modeMethods.map((name) => [name, modeBase[name].bind(modeBase)])); modeStore.createJobWorkspace = async (...args) => { modeWorkspace = await modeBase.createJobWorkspace(...args); return modeWorkspace; }; modeStore.verifySource = async (...args) => { verifyCount += 1; if (verifyCount === 2) await chmod(join(modeWorkspace, 'output.pdf'), 0o640); return modeBase.verifySource(...args); }; const modeService = new PdfAcroFormCheckboxService({ store: modeStore }); await assert.rejects(modeService.add(mode.source.id, request(mode.bytes)), { code: 'ACROFORM_CHECKBOX_TAMPERED' });
});

test('AcroForm checkbox service cancels after promotion and revokes the artifact', async (t) => {
  const state = await setup(t); const controller = new AbortController(); const base = state.store; const methods = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact']; const wrapped = Object.fromEntries(methods.map((name) => [name, base[name].bind(base)])); wrapped.promotePdfArtifact = async (...args) => { const artifact = await base.promotePdfArtifact(...args); controller.abort(); return artifact; }; const service = new PdfAcroFormCheckboxService({ store: wrapped }); await assert.rejects(service.add(state.source.id, request(state.bytes), { signal: controller.signal }), { code: 'JOB_CANCELLED' }); assert.deepEqual(await readdir(join(base.root, 'jobs')), []);
});
