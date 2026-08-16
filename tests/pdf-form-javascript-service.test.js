import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { analyzePdfFormJavaScript } from '../scripts/host/pdf-form-javascript-analyzer.mjs';
import { PdfFormJavaScriptInventoryService } from '../scripts/host/pdf-form-javascript-service.mjs';
import { formJavaScriptRequest, makeFormJavaScriptPdf } from './host-pdf-form-javascript-fixtures.mjs';

async function setup(t, options = {}) { const root = await mkdtemp(join(tmpdir(), 'pdf-form-javascript-')); const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose()); const bytes = makeFormJavaScriptPdf(); const source = await store.createDocument({ stream: (async function* () { yield bytes; }()), displayName: 'form.pdf' }); return { root, store, bytes, source, request: formJavaScriptRequest(bytes), service: new PdfFormJavaScriptInventoryService({ store, ...options }) }; }

test('form JavaScript service returns a source-bound report and cleans its private workspace', async (t) => { const state = await setup(t); const result = await state.service.inspect(state.source.id, state.request); assert.equal(result.kind, 'pdf-form-javascript-inventory'); assert.equal(result.report.sourceSha256, state.source.sha256); assert.equal(result.report.actionCount, 1); assert.equal(result.limitations.length, 3); assert.deepEqual(await readdir(join(state.root, 'jobs')), []); });
test('form JavaScript service rejects forged injected analyzer output', async (t) => { const state = await setup(t, { analyzer: (bytes, request) => ({ ...analyzePdfFormJavaScript(bytes, request), actionCount: 0 }) }); await assert.rejects(state.service.inspect(state.source.id, state.request), { code: 'PDF_FORM_JAVASCRIPT_OUTPUT_INVALID' }); assert.deepEqual(await readdir(join(state.root, 'jobs')), []); });
test('form JavaScript service rejects source drift and exact-request violations before analysis', async (t) => { const state = await setup(t); await assert.rejects(state.service.inspect(state.source.id, { ...state.request, sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' }); await assert.rejects(state.service.inspect(state.source.id, { ...state.request, extra: true }), { code: 'PDF_FORM_JAVASCRIPT_OPTIONS_INVALID' }); });
test('form JavaScript service cancels after analyzer completion and cleans workspace', async (t) => { const controller = new AbortController(); const state = await setup(t, { analyzer: (bytes, request) => { const report = analyzePdfFormJavaScript(bytes, request); controller.abort(); return report; } }); await assert.rejects(state.service.inspect(state.source.id, state.request, { signal: controller.signal }), { code: 'JOB_CANCELLED' }); assert.deepEqual(await readdir(join(state.root, 'jobs')), []); });
