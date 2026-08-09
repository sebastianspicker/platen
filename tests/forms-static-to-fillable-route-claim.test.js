import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createAcroFormTextFieldEndpoints } from '../src/core/local-host-acroform-text-field-endpoints.js';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormTextFieldService } from '../scripts/host/pdf-acroform-text-field-service.mjs';
import { inspectPdfAcroFormTextField } from '../scripts/host/pdf-acroform-text-field-writer.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { buildClassicPassivePdf } from '../scripts/host/professional-capability/classic-structure-pdf.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const TOKEN = 'a'.repeat(64);
const PROFILE = 'local-pdf-acroform-text-field-v1';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forms-static-to-fillable-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const sourceBytes = buildClassicPassivePdf({ pages: 1 });
  const document = await store.createDocument({
    stream: (async function* () { yield sourceBytes; }()),
    displayName: 'source.pdf',
  });
  const request = {
    profile: PROFILE,
    sourceSha256: document.sha256,
    page: 1,
    fieldName: 'Static.Name',
    rect: { x: 72, y: 700, width: 180, height: 24 },
  };
  const service = new PdfAcroFormTextFieldService({ store });
  const app = createAppHandler({
    staticHandler: () => {},
    store,
    service: { availability: async () => [] },
    workspaceState: {},
    acroFormTextField: service,
    token: TOKEN,
    host: '127.0.0.1',
    port: 4173,
  });
  return { app, document, request, root, service, sourceBytes, store };
}

function appFetch(app) {
  return async (path, options = {}) => {
    const response = await invoke(app, {
      method: options.method ?? 'GET',
      url: path,
      headers: {
        origin: 'http://127.0.0.1:4173',
        ...(options.headers ?? {}),
        ...(options.headers?.['Content-Type'] ? { 'content-type': options.headers['Content-Type'] } : {}),
        ...(options.headers?.['X-Platen-Token'] ? { 'x-platen-token': options.headers['X-Platen-Token'] } : {}),
      },
      body: options.body,
    });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}

test('forms.static-to-fillable creates one empty terminal text field through the authenticated route and validating client', async (t) => {
  const state = await fixture(t);
  // Narrow claim only: one empty terminal text field on a form-free passive PDF.
  // It excludes filling existing forms, checkbox/radio/choice authoring, signatures,
  // JavaScript/calculation/XFA, and byte or signature preservation.
  assert.equal(state.sourceBytes.includes(Buffer.from('/AcroForm', 'latin1')), false);
  assert.equal(state.sourceBytes.includes(Buffer.from('/Annots', 'latin1')), false);
  const client = new LocalHostClient({ fetchImpl: appFetch(state.app) });
  await client.bootstrap();
  const signal = new AbortController().signal;
  const result = await client.addAcroFormTextField(state.document.id, state.request, { signal });

  assert.equal(result.artifact.documentId, state.document.id);
  assert.notEqual(result.artifact.id, state.document.id);
  assert.equal(result.artifact.displayName, 'text-field-form.pdf');
  assert.equal(result.artifact.mediaType, 'application/pdf');
  assert.equal(result.artifact.sha256, result.artifact.operation.expected.outputSha256);
  assert.deepEqual(result.artifact.operation.inputs, [{ documentId: state.document.id, sha256: state.document.sha256, role: 'source' }]);
  assert.equal(result.artifact.operation.parameters.profile, PROFILE);
  assert.equal(result.artifact.operation.parameters.page, state.request.page);
  assert.deepEqual(result.artifact.operation.parameters.rect, state.request.rect);
  assert.equal(result.artifact.operation.expected.defaultEmpty, true);
  assert.equal(result.artifact.operation.expected.sourcePrefixPreserved, true);
  assert.equal(result.artifact.operation.expected.signaturePreservation, false);
  assert.equal(result.artifact.operation.validation.passed, true);
  assert.equal(result.proof.sourceSha256, state.document.sha256);
  assert.equal(result.proof.fieldNameSha256, digest(Buffer.from(state.request.fieldName, 'utf8')));
  assert.equal(result.proof.defaultEmpty, true);
  assert.equal(result.proof.sourcePrefixPreserved, true);
  assert.equal(result.proof.objectCount, 4);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.artifact), true);
  assert.equal(Object.isFrozen(result.artifact.operation.validation.validators), true);
  assert.match(result.limitations.join(' '), /existing forms, widgets, signatures, encryption, tags, layers, actions, JavaScript, calculations, XFA/);

  const retained = state.store.getArtifact(result.artifact.id);
  assert.equal(retained.id, result.artifact.id);
  assert.equal(retained.documentId, state.document.id);
  const outputBytes = await readFile(retained.filePath);
  assert.equal(digest(outputBytes), retained.sha256);
  assert.equal(digest(await readFile(state.store.getSourcePath(state.document.id))), state.document.sha256);
  assert.deepEqual(inspectPdfAcroFormTextField(state.sourceBytes, outputBytes, state.request), result.proof);
});

test('forms.static-to-fillable binds the exact request and rejects a forged local receipt', async (t) => {
  const state = await fixture(t);
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    return appFetch(state.app)(path, options);
  } });
  await client.bootstrap();
  const result = await client.addAcroFormTextField(state.document.id, state.request);
  assert.equal(calls.at(-1).path, `/api/documents/${state.document.id}/acroform-text-field`);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), state.request);
  assert.equal(calls.at(-1).options.signal, undefined);

  const forged = structuredClone(result);
  forged.artifact.operation.validation.outputSha256 = '0'.repeat(64);
  const endpoint = createAcroFormTextFieldEndpoints({ json: async () => ({ result: forged }) });
  await assert.rejects(endpoint.addAcroFormTextField(state.document.id, state.request), /invalid/i);
});

test('forms.static-to-fillable forwards cancellation to the real service and revokes its promoted artifact', async (t) => {
  const state = await fixture(t);
  const controller = new AbortController();
  let promotedId = null;
  const base = state.store;
  const wrapped = {};
  for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact']) {
    wrapped[name] = base[name].bind(base);
  }
  wrapped.promotePdfArtifact = async (...args) => {
    const artifact = await base.promotePdfArtifact(...args);
    promotedId = artifact.id;
    controller.abort();
    return artifact;
  };
  const service = new PdfAcroFormTextFieldService({ store: wrapped });
  await assert.rejects(service.add(state.document.id, state.request, { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.throws(() => state.store.getArtifact(promotedId), { code: 'ARTIFACT_NOT_FOUND' });
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});
