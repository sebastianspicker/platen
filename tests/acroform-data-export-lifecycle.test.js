import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, link, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAcroFormDataExportResult } from '../scripts/host/pdf-acroform-data-export-contract.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormDataExportService } from '../scripts/host/pdf-acroform-data-export-service.mjs';
import { preparePdfAcroFormTextField } from '../scripts/host/pdf-acroform-text-field-writer.mjs';
import { formFixture, digest } from '../scripts/host/professional-capability/fixtures.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from '../scripts/host/private-source-copy.mjs';
import { handleAcroFormDataExportRoute } from '../scripts/host/routes/acroform-data-export-routes.mjs';

const documentId = '11111111-1111-4111-8111-111111111111'; const sourceSha256 = 'a'.repeat(64);
function response() { return Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false }); }
function context(service) {
  const target = response(); let calls = 0;
  return { operation: 'acroform-data-export', request: { method: 'POST' }, response: target, url: new URL(`http://127.0.0.1/api/documents/${documentId}/acroform-data-export`), documentId, processing: { signal: new AbortController().signal }, store: { getDocument: () => ({ sha256: sourceSha256 }) }, acroFormDataExport: service, bodyLimit: 256, method: () => {}, readJson: async () => ({ profile: 'local-acroform-data-export-v1', sourceSha256 }), exactJsonObject: () => true, json: () => { calls += 1; }, calls: () => calls, target };
}
test('AcroForm data export suppresses a disconnected response after service completion', async () => {
  const result = createAcroFormDataExportResult({ sourceSha256, fieldName: 'Field', currentValue: 'Ada' }); const value = context({ export: async () => { value.target.destroyed = true; return result; } });
  assert.equal(await handleAcroFormDataExportRoute(value), true); assert.equal(value.calls(), 0);
});

async function sourceState(t) { const root = await mkdtemp(join(tmpdir(), 'acroform-export-lifecycle-')); const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose()); const source = formFixture(); const bytes = preparePdfAcroFormTextField(source, { profile: 'local-pdf-acroform-text-field-v1', sourceSha256: digest(source), page: 1, fieldName: 'Field', rect: { x: 72, y: 700, width: 100, height: 20 } }).bytes; const document = await store.createDocument({ stream: (async function* () { yield bytes; }()), displayName: 'form.pdf' }); return { root, store, document }; }
test('AcroForm data export fails closed when injected staging changes mode or link count', async (t) => {
  for (const mutate of [async (path) => chmod(path, 0o600), async (path) => link(path, `${path}.link`)]) {
    const value = await sourceState(t); const service = new PdfAcroFormDataExportService({ store: value.store, sourceCopy: { stage: async (options) => { const identity = await stagePrivateSourceCopy(options); await mutate(options.targetPath); return identity; }, assert: assertPrivateSourceCopy } });
    await assert.rejects(service.export(value.document.id, { profile: 'local-acroform-data-export-v1', sourceSha256: value.document.sha256 }), { code: 'ACROFORM_DATA_EXPORT_TAMPERED' });
    assert.deepEqual(await readdir(join(value.root, 'jobs')), []);
  }
});
test('AcroForm data export maps a mocked 60-second deadline to timeout and cleans up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const value = await sourceState(t); let release; const gate = new Promise((resolve) => { release = resolve; }); let calls = 0;
  const base = value.store; const wrapped = Object.fromEntries(['getDocument', 'getSourcePath', 'createJobWorkspace', 'cleanupJob'].map((name) => [name, base[name].bind(base)])); wrapped.verifySource = async (...args) => { calls += 1; if (calls === 1) return gate; return base.verifySource(...args); };
  const pending = new PdfAcroFormDataExportService({ store: wrapped }).export(value.document.id, { profile: 'local-acroform-data-export-v1', sourceSha256: value.document.sha256 }); t.mock.timers.tick(60_000); release();
  await assert.rejects(pending, { code: 'ACROFORM_DATA_EXPORT_TIMEOUT' }); assert.deepEqual(await readdir(join(value.root, 'jobs')), []);
});
