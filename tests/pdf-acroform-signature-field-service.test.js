import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormSignatureFieldService } from '../scripts/host/pdf-acroform-signature-field-service.mjs';
import { inspectPdfAcroFormSignatureField, preparePdfAcroFormSignatureField } from '../scripts/host/pdf-acroform-signature-field-writer.mjs';

function sourcePdf() { const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
let body = '%PDF-1.7\n';
const offsets = [];
for (let index = 0;
index < objects.length;
index += 1) { offsets.push(Buffer.byteLength(body));
body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
} const xref = Buffer.byteLength(body);
body += `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
return Buffer.from(body, 'latin1');
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex');
}
function request(bytes, extra = {}) { return { profile: 'local-pdf-acroform-signature-field-v1', sourceSha256: digest(bytes), page: 1, fieldName: 'Sign.Here', rect: { x: 72, y: 700, width: 180, height: 24 }, ...extra };
}
async function setup(t) { const root = await mkdtemp('/private/tmp/pdf-acroform-signature-field-service-');
const store = await new DocumentStore({ root }).initialize();
t.after(() => store.dispose());
const bytes = sourcePdf();
const source = await store.createDocument({ stream: (async function* () { yield bytes;
})(), displayName: 'source.pdf' });
return { store, source, bytes, service: new PdfAcroFormSignatureFieldService({ store }) };
}
test('signature-field service stages, reinspects, promotes, and cleans its private workspace', async (t) => { const state = await setup(t);
const result = await state.service.add(state.source.id, request(state.bytes));
assert.equal(result.proof.emptyUnsigned, true);
assert.equal(result.artifact.displayName, 'signature-field-form.pdf');
assert.deepEqual(await readdir(join(state.store.root, 'jobs')), []);
assert.deepEqual(await readFile(state.store.getSourcePath(state.source.id)), state.bytes);
});
test('signature-field service rejects accessors and cancels before promotion', async (t) => { const state = await setup(t);
const getter = request(state.bytes);
Object.defineProperty(getter, 'fieldName', { get() { throw new Error('getter');
}, enumerable: true });
await assert.rejects(state.service.add(state.source.id, getter), { code: 'INVALID_ACROFORM_SIGNATURE_FIELD_OPTIONS' });
const controller = new AbortController();
const base = state.store;
const wrapped = {};
for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact']) wrapped[name] = base[name].bind(base);
wrapped.promotePdfArtifact = async (...args) => { const artifact = await base.promotePdfArtifact(...args);
controller.abort();
return artifact;
};
await assert.rejects(new PdfAcroFormSignatureFieldService({ store: wrapped }).add(state.source.id, request(state.bytes), { signal: controller.signal }), { code: 'JOB_CANCELLED' });
assert.deepEqual(await readdir(join(base.root, 'jobs')), []);
});
test('signature-field service keeps output immutable and detects source replacement before promotion', async (t) => { const state = await setup(t); const base = state.store; let workspace; const wrapped = {};
for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'cleanupJob', 'deleteArtifact']) wrapped[name] = base[name].bind(base);
wrapped.createJobWorkspace = async (...args) => { workspace = await base.createJobWorkspace(...args); return workspace; };
wrapped.promotePdfArtifact = async (...args) => { assert.equal((await lstat(join(workspace, 'output.pdf')).then((value) => value.mode & 0o777)), 0o400); return base.promotePdfArtifact(...args); };
const result = await new PdfAcroFormSignatureFieldService({ store: wrapped }).add(state.source.id, request(state.bytes)); assert.equal(result.proof.emptyUnsigned, true);
const swapped = await setup(t); let verification = 0; const swapStore = {};
for (const name of ['getDocument', 'getSourcePath', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']) swapStore[name] = swapped.store[name].bind(swapped.store);
swapStore.verifySource = async (...args) => { verification += 1; if (verification === 2) await writeFile(swapped.store.getSourcePath(swapped.source.id), Buffer.concat([swapped.bytes, Buffer.from('swap')])); return swapped.store.verifySource(...args); };
await assert.rejects(new PdfAcroFormSignatureFieldService({ store: swapStore }).add(swapped.source.id, request(swapped.bytes)), { code: 'SOURCE_INTEGRITY_FAILED' }); assert.deepEqual(await readdir(join(swapped.store.root, 'jobs')), []); await chmod(join(base.root, 'jobs'), 0o700).catch(() => {});
});

test('signature-field service rejects forged core proof and output bytes before promotion', async (t) => { const state = await setup(t); const forgedCore = { preparePdfAcroFormSignatureField: (bytes, value) => { const prepared = preparePdfAcroFormSignatureField(bytes, value); return { bytes: Buffer.from(prepared.bytes), proof: { ...prepared.proof, emptyUnsigned: false } }; }, inspectPdfAcroFormSignatureField };
  await assert.rejects(new PdfAcroFormSignatureFieldService({ store: state.store, core: forgedCore }).add(state.source.id, request(state.bytes)), { code: 'ACROFORM_SIGNATURE_FIELD_OUTPUT_INVALID' }); assert.deepEqual(await readdir(join(state.store.root, 'jobs')), []);
  const tamperedCore = { preparePdfAcroFormSignatureField, inspectPdfAcroFormSignatureField: (source, output, value) => inspectPdfAcroFormSignatureField(source, Buffer.concat([output, Buffer.from('tamper')]), value) }; await assert.rejects(new PdfAcroFormSignatureFieldService({ store: state.store, core: tamperedCore }).add(state.source.id, request(state.bytes)), { code: 'ACROFORM_SIGNATURE_FIELD_OUTPUT_INVALID' });
});

test('signature-field service reports typed cleanup failure and revokes a promoted artifact', async (t) => { const state = await setup(t); let deleted = null; const base = state.store; const wrapped = {}; for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'promotePdfArtifact']) wrapped[name] = base[name].bind(base); wrapped.deleteArtifact = async (id) => { deleted = id; return base.deleteArtifact(id); }; wrapped.cleanupJob = async () => { throw new Error('cleanup failed'); }; await assert.rejects(new PdfAcroFormSignatureFieldService({ store: wrapped }).add(state.source.id, request(state.bytes)), { code: 'ACROFORM_SIGNATURE_FIELD_CLEANUP_FAILED' }); assert.ok(deleted); });

test('signature-field service rejects an unexpected private workspace entry', async (t) => { const state = await setup(t); const base = state.store; const wrapped = {}; for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']) wrapped[name] = base[name].bind(base); wrapped.createJobWorkspace = async (...args) => { const path = await base.createJobWorkspace(...args); await writeFile(join(path, 'unexpected'), 'x'); return path; }; await assert.rejects(new PdfAcroFormSignatureFieldService({ store: wrapped }).add(state.source.id, request(state.bytes)), { code: 'ACROFORM_SIGNATURE_FIELD_TAMPERED' }); assert.deepEqual(await readdir(join(base.root, 'jobs')), []); });
