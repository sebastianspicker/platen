import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { InputAssetStore } from '../scripts/host/input-asset-store.mjs';
import { PdfFileAudioAttachmentService } from '../scripts/host/pdf-file-audio-attachment-service.mjs';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { handleFileAudioAttachmentRoute } from '../scripts/host/routes/file-audio-attachment-routes.mjs';
import {
  createFileAudioAttachmentEndpoints,
} from '../src/core/local-host-file-audio-attachment-endpoints.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const profile = 'local-file-audio-attachment-v1';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-file-audio-attachments-'));
  const store = await new DocumentStore({ root: join(root, 'documents') }).initialize();
  const inputs = await new InputAssetStore({ root: join(root, 'inputs') }).initialize();
  t.after(async () => { await store.dispose(); });
  const sourceBytes = makeMultiPagePdf(['file audio attachment']);
  const document = await store.createDocument({ stream: Readable.from([sourceBytes]), displayName: 'source.pdf' });
  const assetBytes = Buffer.from('attachment payload');
  const asset = await inputs.createInput({ stream: Readable.from([assetBytes]), displayName: 'payload.txt', mediaType: 'text/plain' });
  const request = Object.freeze({
    profile,
    sourceSha256: document.sha256,
    assetId: asset.id,
    assetSha256: asset.sha256,
    mediaType: 'text/plain',
    extension: '.txt',
    page: 1,
    rect: Object.freeze({ x: 72, y: 640, width: 96, height: 36 }),
  });
  const service = new PdfFileAudioAttachmentService({ store, inputs });
  return { root, store, inputs, sourceBytes, document, asset, assetBytes, request, service };
}

function exactJsonObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function routeContext(state, body, service = state.service, { signal = new AbortController().signal } = {}) {
  const response = new EventEmitter();
  const calls = [];
  const deleted = [];
  return {
    request: { method: 'POST' }, response,
    url: new URL(`http://local/api/documents/${state.document.id}/file-audio-attachment`),
    documentId: state.document.id, operation: 'file-audio-attachment', processing: { signal }, store: state.store,
    fileAudioAttachments: { add: async (...args) => { calls.push(args); return service.add(...args); } },
    bodyLimit: 4_096, exactJsonObject, method: (value, expected) => assert.equal(value.method, expected),
    readJson: async () => body, json: (_response, status, value) => { response.status = status; response.value = value; },
    calls, deleted,
  };
}

test('file/audio route uses the real stores and emits an inert, source-bound FileAttachment artifact', async (t) => {
  const state = await setup(t);
  const context = routeContext(state, state.request);
  assert.equal(await handleFileAudioAttachmentRoute(context), true);
  assert.equal(context.response.status, 201);
  assert.deepEqual(context.calls[0][1], state.request);
  assert(context.calls[0][2].signal instanceof AbortSignal);
  const result = context.response.value.result;
  assert.equal(result.kind, 'pdf-file-audio-attachment');
  assert.equal(result.artifact.documentId, state.document.id);
  assert.equal(result.artifact.operation.type, 'pdf-file-audio-attachment');
  assert.equal(result.artifact.operation.inputs[1].assetId, state.asset.id);
  assert.equal(result.artifact.operation.inputs[1].sha256, state.asset.sha256);
  assert.equal(result.artifact.operation.expected.annotationSubtype, 'FileAttachment');
  assert.equal('filePath' in result.artifact, false);
  const retained = state.store.getArtifact(result.artifact.id);
  const output = await readFile(retained.filePath);
  assert.equal(sha256(output), result.artifact.sha256);
  assert(output.subarray(0, state.sourceBytes.length).equals(state.sourceBytes));
  assert.match(output.toString('latin1'), /\/Subtype \/FileAttachment/);
  assert.doesNotMatch(output.toString('latin1'), /\/Subtype \/Sound/);
  assert.equal(result.evidence.passiveFileAttachment, true);
  assert.equal(result.evidence.noActions, true);
  await state.store.deleteArtifact(result.artifact.id);
});

test('file/audio client factory freezes the request/result, forwards the route body, and carries cancellation', async (t) => {
  const state = await setup(t);
  const route = routeContext(state, state.request);
  await handleFileAudioAttachmentRoute(route);
  const responseResult = route.response.value.result;
  const controller = new AbortController();
  const calls = [];
  const client = createFileAudioAttachmentEndpoints({ json: async (path, options) => {
    calls.push({ path, options }); return { result: responseResult };
  } });
  const result = await client.addFileAudioAttachment(state.document.id, state.request, { signal: controller.signal });
  assert.equal(calls[0].path, `/api/documents/${state.document.id}/file-audio-attachment`);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].options.body), state.request);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.artifact));
  assert.equal('filePath' in result.artifact, false);
  assert.throws(() => client.addFileAudioAttachment(state.document.id, { ...state.request, extra: true }), TypeError);
  await state.store.deleteArtifact(responseResult.artifact.id);
});

test('aborted delivery revokes a promoted artifact before responding', async (t) => {
  const state = await setup(t);
  const promoted = await state.service.add(state.document.id, state.request, { sourceSha256: state.document.sha256 });
  const controller = new AbortController(); controller.abort();
  const context = routeContext(state, state.request, { add: async () => promoted }, { signal: controller.signal });
  assert.equal(await handleFileAudioAttachmentRoute(context), true);
  await assert.rejects(async () => state.store.getArtifact(promoted.artifact.id), { code: 'ARTIFACT_NOT_FOUND' });
  assert.equal(context.response.status, undefined);
});

test('forged result is rejected and its matching retained artifact is cleaned up', async (t) => {
  const state = await setup(t);
  const promoted = await state.service.add(state.document.id, state.request, { sourceSha256: state.document.sha256 });
  const forged = { ...promoted, evidence: { ...promoted.evidence, noActions: false } };
  const context = routeContext(state, state.request, { add: async () => forged });
  await assert.rejects(handleFileAudioAttachmentRoute(context), { code: 'PDF_FILE_AUDIO_ATTACHMENT_RESULT_INVALID' });
  await assert.rejects(async () => state.store.getArtifact(promoted.artifact.id), { code: 'ARTIFACT_NOT_FOUND' });
});
