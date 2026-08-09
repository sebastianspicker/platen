import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { DocumentStore } from '../scripts/host/document-store.mjs';
import { handleSpecialistContentRoute } from '../scripts/host/routes/specialist-content-routes.mjs';
import { PdfSpecialistContentService } from '../scripts/host/pdf-specialist-content-service.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { digest, embeddedSource, malformedEmbeddedSource, requestFor } from './support/r11-embedded-files-fixtures.js';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

async function setupDocument(t, source = embeddedSource()) {
  const root = await mkdtemp(join(tmpdir(), 'r11-embedded-files-'));
  const store = await new DocumentStore({ root }).initialize();
  const document = await store.createDocument({ stream: Readable.from([source]), displayName: 'embedded.pdf' });
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  return { store, document, source, service: new PdfSpecialistContentService({ store }) };
}

function routeContext({ service, document, body = requestFor(embeddedSource()), query = '' }) {
  const response = {};
  return {
    request: { method: 'POST' }, response,
    url: new URL(`http://local.test/api/documents/${document.id}/specialist-content${query}`),
    documentId: document.id, operation: 'specialist-content',
    processing: { signal: new AbortController().signal }, specialistContentReady: true,
    specialistContent: service, bodyLimit: 2048,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.value = value; },
  };
}

test('R11 document.embedded-files is a retained-source-bound bounded inventory', async (t) => {
  const state = await setupDocument(t);
  const result = await state.service.inspect(state.document.id, requestFor(state.source), { sourceSha256: state.document.sha256 });
  const expectedSha = createHash('sha256').update('R11-DATA').digest('hex');
  assert.equal(result.profile, 'local-pdf-specialist-content-v1');
  assert.equal(result.sourceSha256, state.document.sha256);
  assert.deepEqual(result.embeddedFiles, { count: 1, aggregateBytes: 8, records: [{ ordinal: 1, page: 1, bytes: 8, sha256: expectedSha }], truncated: false });
  assert.equal(result.evidence.readOnly, true);
  for (const key of ['payloadBytesReturned', 'namesReturned', 'textReturned', 'pathsReturned', 'objectReferencesReturned']) assert.equal(result.evidence[key], false);
  assert.equal(result.evidence.sourceDigestReverified, true);
  assert.equal(result.evidence.sourceUnchangedDuringExtraction, true);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['private.txt', 'R11-DATA', 'source.pdf', 'sourcePath']) assert.doesNotMatch(serialized, new RegExp(forbidden.replace('.', '\\.'), 'u'));
  assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), state.source);
});

test('R11 shipped specialist-content route forwards the retained document identity and digest', async (t) => {
  const state = await setupDocument(t);
  const context = routeContext({ service: state.service, document: state.document, body: requestFor(state.source) });
  assert.equal(await handleSpecialistContentRoute(context), true);
  assert.equal(context.response.status, 200);
  assert.equal(context.response.value.result.sourceSha256, state.document.sha256);
  assert.equal(context.response.value.result.embeddedFiles.records[0].page, 1);
  await assert.rejects(handleSpecialistContentRoute(routeContext({ service: state.service, document: state.document, body: { ...requestFor(state.source), extra: true } })), { code: 'PDF_SPECIALIST_CONTENT_OPTIONS_INVALID' });
  await assert.rejects(handleSpecialistContentRoute(routeContext({ service: state.service, document: state.document, body: requestFor(state.source), query: '?unexpected=1' })), { code: 'INVALID_PARAMETER' });
});

test('R11 client rejects forged embedded-file payload or name fields', async (t) => {
  const state = await setupDocument(t);
  const valid = await state.service.inspect(state.document.id, requestFor(state.source), { sourceSha256: state.document.sha256 });
  const forged = structuredClone(valid);
  forged.embeddedFiles.records[0].name = 'private.txt';
  const client = new LocalHostClient({ fetchImpl: async (path) => path === '/api/bootstrap'
    ? new Response(JSON.stringify({ sessionToken: 'b'.repeat(64) }), { status: 200 })
    : new Response(JSON.stringify({ result: forged }), { status: 200 }) });
  await client.bootstrap();
  await assert.rejects(client.inspectSpecialistContent(state.document.id, state.document.sha256), TypeError);
});

test('R11 rejects malformed Filespec/EF graphs instead of guessing', async (t) => {
  const state = await setupDocument(t, malformedEmbeddedSource());
  await assert.rejects(state.service.inspect(state.document.id, requestFor(state.source), { sourceSha256: state.document.sha256 }), { code: 'PDF_SPECIALIST_CONTENT_SOURCE_UNSUPPORTED', status: 422 });
});

test('R11 source drift, cancellation, and source bounds remain hard failures', async (t) => {
  const state = await setupDocument(t);
  await assert.rejects(state.service.inspect(state.document.id, requestFor(state.source), { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(state.service.inspect(state.document.id, requestFor(state.source), { sourceSha256: state.document.sha256, signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });

  const root = await mkdtemp(join(tmpdir(), 'r11-embedded-bounds-'));
  const path = join(root, 'source.pdf');
  const sha256 = digest(state.source);
  let verifies = 0;
  const bounded = new PdfSpecialistContentService({ store: {
    getDocument: () => ({ id: state.document.id, size: MAX_SOURCE_BYTES + 1, sha256 }),
    getSourcePath: () => path,
    verifySource: async () => { verifies += 1; },
  } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, state.source, { mode: 0o600 });
  await assert.rejects(bounded.inspect(state.document.id, requestFor(state.source), { sourceSha256: sha256 }), { code: 'PDF_SPECIALIST_CONTENT_INPUT_TOO_LARGE', status: 413 });
  assert.equal(verifies, 0);
});

test('R11 source mutation after extraction is detected before result publication', async (t) => {
  const source = embeddedSource();
  const root = await mkdtemp(join(tmpdir(), 'r11-embedded-drift-'));
  const path = join(root, 'source.pdf');
  const sha256 = digest(source);
  await writeFile(path, source, { mode: 0o600 });
  let verifies = 0;
  const service = new PdfSpecialistContentService({ store: {
    getDocument: () => ({ id: '11111111-1111-4111-8111-111111111111', size: source.length, sha256 }),
    getSourcePath: () => path,
    verifySource: async () => { verifies += 1; if (verifies === 2) await writeFile(path, Buffer.from('drift')); },
  } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(service.inspect('11111111-1111-4111-8111-111111111111', requestFor(source), { sourceSha256: sha256 }), { code: 'SOURCE_INTEGRITY_FAILED', status: 500 });
});

test('R11 route rejects accessor/proxy bodies before specialist inspection', async (t) => {
  const state = await setupDocument(t);
  const body = new Proxy(requestFor(state.source), { ownKeys: () => { throw new Error('hostile ownKeys'); } });
  await assert.rejects(handleSpecialistContentRoute(routeContext({ service: state.service, document: state.document, body })), /hostile ownKeys/u);
});
