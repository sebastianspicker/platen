import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfTextReflowService } from '../scripts/host/pdf-text-reflow-service.mjs';
import { createTextReflowEndpoints } from '../src/core/local-host-text-reflow-endpoints.js';
import { makeTextReflowPdf, textReflowRequest } from './host-pdf-text-reflow-fixtures.mjs';

async function setup(t) {
  const store = await new DocumentStore({ root: await mkdtemp(join(tmpdir(), 'text-reflow-client-')) }).initialize();
  t.after(() => store.dispose());
  const bytes = makeTextReflowPdf();
  const document = await store.createDocument({
    stream: (async function* () { yield bytes; }()),
    displayName: 'source.pdf',
  });
  const fullRequest = textReflowRequest(bytes);
  const request = { ...fullRequest };
  delete request.profile;
  delete request.sourceSha256;
  const result = await new PdfTextReflowService({ store }).reflow(document.id, fullRequest);
  return { store, document, request, result };
}

test('text-reflow client sends the fixed source-bound request and freezes the validated result', async (t) => {
  const state = await setup(t);
  let transport;
  const endpoints = createTextReflowEndpoints({
    json: async (path, options) => {
      transport = { path, options };
      return { result: structuredClone(state.result) };
    },
  });
  const result = await endpoints.reflowText(state.document.id, state.document.sha256, state.request);
  assert.equal(transport.path, `/api/documents/${state.document.id}/text-reflow`);
  const body = JSON.parse(transport.options.body);
  assert.equal(body.profile, 'local-pdf-text-reflow-v1');
  assert.equal(body.sourceSha256, state.document.sha256);
  assert.deepEqual(body.streamRef, state.request.streamRef);
  assert.equal(result.artifact.id, state.result.artifact.id);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.artifact), true);
  assert.equal(Object.isFrozen(result.proof), true);
  await state.store.deleteArtifact(state.result.artifact.id);
});

test('text-reflow client rejects malformed request descriptors and options', async () => {
  const endpoints = createTextReflowEndpoints({ json: async () => assert.fail('transport must not run') });
  const request = {
    page: 1, streamRef: { object: 4, generation: 0 }, lineTokenIndices: [7, 10, 13],
    lineWidth: 20, originalTextSha256: 'f'.repeat(64), replacementText: 'Alpha beta',
  };
  const getter = { ...request };
  Object.defineProperty(getter, 'page', { enumerable: true, get() { throw new Error('getter'); } });
  assert.throws(() => endpoints.reflowText('11111111-1111-4111-8111-111111111111', 'a'.repeat(64), getter), TypeError);
  assert.throws(() => endpoints.reflowText('11111111-1111-4111-8111-111111111111', 'a'.repeat(64), request, { extra: true }), TypeError);
});

test('text-reflow client rejects forged or tampered host results', async (t) => {
  const state = await setup(t);
  const tampered = structuredClone(state.result);
  tampered.artifact.sha256 = '0'.repeat(64);
  const endpoints = createTextReflowEndpoints({ json: async () => ({ result: tampered }) });
  await assert.rejects(
    endpoints.reflowText(state.document.id, state.document.sha256, state.request),
    { code: 'INVALID_LOCAL_HOST' },
  );
  await state.store.deleteArtifact(state.result.artifact.id);
});

