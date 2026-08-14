import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormTextFieldService } from '../scripts/host/pdf-acroform-text-field-service.mjs';

function sourcePdf() { const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream']; let body = '%PDF-1.7\n'; const offsets = []; for (let index = 0; index < objects.length; index += 1) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; } const xref = Buffer.byteLength(body); body += `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(body, 'latin1'); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(bytes, extra = {}) { return { profile: 'local-pdf-acroform-text-field-v1', sourceSha256: digest(bytes), page: 1, fieldName: 'Account.Name', rect: { x: 72, y: 700, width: 180, height: 24 }, ...extra }; }
async function setup(t) { const root = await mkdtemp('/private/tmp/pdf-acroform-text-field-service-'); const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose()); const bytes = sourcePdf(); const source = await store.createDocument({ stream: (async function* () { yield bytes; })(), displayName: 'source.pdf' }); return { store, source, bytes, service: new PdfAcroFormTextFieldService({ store }) }; }

test('text-field service stages, independently reinspects, promotes, and preserves source', async (t) => { const state = await setup(t); const result = await state.service.add(state.source.id, request(state.bytes)); assert.equal(result.artifact.documentId, state.source.id); assert.equal(result.proof.defaultEmpty, true); assert.deepEqual(await readdir(join(state.store.root, 'jobs')), []); assert.deepEqual(await readFile(state.store.getSourcePath(state.source.id)), state.bytes); assert.equal(result.artifact.operation.expected.defaultEmpty, true); });

test('text-field service snapshots exact descriptors and rejects getters or extras', async (t) => {
  const state = await setup(t);
  const invalidCode = { code: 'INVALID_ACROFORM_TEXT_FIELD_OPTIONS' };
  const getter = request(state.bytes);
  Object.defineProperty(getter, 'fieldName', { get() { throw new Error('getter'); }, enumerable: true });
  await assert.rejects(state.service.add(state.source.id, getter), invalidCode);
  const symbol = request(state.bytes); symbol[Symbol('extra')] = true;
  await assert.rejects(state.service.add(state.source.id, symbol), invalidCode);
  const hidden = request(state.bytes);
  Object.defineProperty(hidden, 'extra', { value: true, enumerable: false });
  await assert.rejects(state.service.add(state.source.id, hidden), invalidCode);
  const rectGetter = request(state.bytes);
  Object.defineProperty(rectGetter.rect, 'x', { get() { throw new Error('getter'); }, enumerable: true });
  await assert.rejects(state.service.add(state.source.id, rectGetter), invalidCode);
});

test('text-field service rejects source drift and staged output tampering', async (t) => { const state = await setup(t); const base = state.store; let verification = 0; const wrapped = {}; for (const name of ['getDocument', 'getSourcePath', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']) wrapped[name] = base[name].bind(base); wrapped.verifySource = async (...args) => { verification += 1; if (verification === 2) await writeFile(base.getSourcePath(state.source.id), Buffer.concat([state.bytes, Buffer.from('drift')])); return base.verifySource(...args); }; const service = new PdfAcroFormTextFieldService({ store: wrapped }); await assert.rejects(service.add(state.source.id, request(state.bytes)), { code: 'SOURCE_INTEGRITY_FAILED' }); assert.deepEqual(await readdir(join(base.root, 'jobs')), []);
  const tamper = await setup(t); const tamperBase = tamper.store; const tamperStore = {}; for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact']) tamperStore[name] = tamperBase[name].bind(tamperBase); tamperStore.promotePdfArtifact = async (documentId, outputPath, options) => { const bytes = await readFile(outputPath); await writeFile(outputPath, Buffer.concat([bytes, Buffer.from('tamper')])); return tamperBase.promotePdfArtifact(documentId, outputPath, options); }; const tamperService = new PdfAcroFormTextFieldService({ store: tamperStore }); await assert.rejects(tamperService.add(tamper.source.id, request(tamper.bytes)), { code: 'ARTIFACT_DIGEST_MISMATCH' }); assert.deepEqual(await readdir(join(tamperBase.root, 'jobs')), []); });

test('text-field service cancels after promotion and revokes the artifact', async (t) => { const state = await setup(t); const controller = new AbortController(); const base = state.store; const wrapped = {}; for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact']) wrapped[name] = base[name].bind(base); wrapped.promotePdfArtifact = async (...args) => { const artifact = await base.promotePdfArtifact(...args); controller.abort(); return artifact; }; const service = new PdfAcroFormTextFieldService({ store: wrapped }); await assert.rejects(service.add(state.source.id, request(state.bytes), { signal: controller.signal }), { code: 'JOB_CANCELLED' }); assert.deepEqual(await readdir(join(base.root, 'jobs')), []); });

test('text-field service detects private staging mode tampering', async (t) => { const state = await setup(t); const base = state.store; let workspace; const wrapped = {}; for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']) wrapped[name] = base[name].bind(base); wrapped.createJobWorkspace = async (...args) => { workspace = await base.createJobWorkspace(...args); return workspace; }; const service = new PdfAcroFormTextFieldService({ store: wrapped }); const timer = setInterval(async () => { if (workspace) { try { await chmod(join(workspace, 'source.pdf'), 0o600); } catch {} } }, 1); t.after(() => clearInterval(timer)); await assert.rejects(service.add(state.source.id, request(state.bytes)), { code: /ACROFORM_TEXT_FIELD_(TAMPERED|SOURCE_UNSUPPORTED|FAILED)/ }); });
