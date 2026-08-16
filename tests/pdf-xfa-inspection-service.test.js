import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { analyzePdfXfaPresence } from '../scripts/host/pdf-xfa-inspection-analyzer.mjs';
import { PdfXfaInspectionService } from '../scripts/host/pdf-xfa-inspection-service.mjs';
import { makeXfaInspectionPdf, xfaInspectionRequest } from './host-pdf-xfa-inspection-fixtures.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-xfa-inspection-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const bytes = makeXfaInspectionPdf({ catalogXfa: true });
  const source = await store.createDocument({ stream: (async function* () { yield bytes; }()), displayName: 'form.pdf' });
  return { root, store, source, request: xfaInspectionRequest(bytes), service: new PdfXfaInspectionService({ store, ...options }) };
}

test('XFA inspection service returns source-bound presence and cleans its private workspace', async (t) => {
  const state = await setup(t);
  const result = await state.service.inspect(state.source.id, state.request);
  assert.equal(result.kind, 'pdf-xfa-presence-inspection');
  assert.equal(result.xfaPresent, true);
  assert.equal(result.proof.sourceSha256, state.source.sha256);
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});

test('XFA inspection service rejects source drift, forged results, and cancellation', async (t) => {
  const state = await setup(t, { analyzer: (bytes, request) => ({ ...analyzePdfXfaPresence(bytes, request), xfaPresent: false }) });
  await assert.rejects(state.service.inspect(state.source.id, state.request), { code: 'PDF_XFA_INSPECTION_OUTPUT_INVALID' });
  await assert.rejects(state.service.inspect(state.source.id, { ...state.request, sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  await writeFile(state.store.getSourcePath(state.source.id), Buffer.from('tampered'), { mode: 0o400 });
  await assert.rejects(state.service.inspect(state.source.id, state.request), { code: 'SOURCE_INTEGRITY_FAILED' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(state.service.inspect(state.source.id, state.request, { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});
