import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { CommentsToOfficeService } from '../scripts/host/comments-to-office-service.mjs';
import { handleCommentsToOfficeRoute } from '../scripts/host/routes/comments-to-office-routes.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { readZipEntries } from '../scripts/host/zip-reader.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import {
  COMMENTS_TO_OFFICE_PROFILE,
  createCommentsToOfficeEndpoints,
  validateCommentsToOfficeResult,
} from '../src/core/local-host-comments-to-office-endpoints.js';

const sourceBytes = Buffer.from('%PDF-1.7\nprivate source bytes');
const annotation = {
  id: 'annotation-1', prototypeSidecar: true, type: 'comment', page: 1,
  rectangle: [1, 2, 3, 4], text: 'Review this paragraph', author: 'reviewer-ada', status: 'open',
  properties: {}, mentions: [], createdAt: '2026-08-03T10:00:00.000Z', replies: [],
};

async function setup() {
  const store = await new DocumentStore({ root: await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp('/tmp/comments-to-office-')) }).initialize();
  const source = await store.createDocument({ stream: Readable.from([sourceBytes]), displayName: 'source.pdf' });
  const workspace = new WorkspaceStateStore(store);
  workspace.createEntity(source.id, 'annotations', annotation);
  const service = new CommentsToOfficeService({ documents: store, workspace });
  return { store, source, workspace, service };
}

function routeContext({ source, service, store, signal = new AbortController().signal, resultOverride = null, destroyed = false }) {
  const response = Object.assign(new EventEmitter(), { destroyed, writableEnded: false });
  let responseBody;
  const body = {
    profile: COMMENTS_TO_OFFICE_PROFILE,
    sourceSha256: source.sha256,
    revision: 1,
    selectedIds: null,
  };
  return {
    context: {
      request: { method: 'POST' }, response,
      url: new URL(`http://local.test/api/documents/${source.id}/comments-to-office`),
      documentId: source.id, operation: 'comments-to-office', processing: { signal },
      store, commentsToOffice: resultOverride ? { export: async () => resultOverride } : service,
      bodyLimit: 2_048,
      exactJsonObject: (value, keys) => value && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)),
      method: (request, expected) => assert.equal(request.method, expected),
      readJson: async () => body,
      json: (_response, status, payload) => { response.status = status; responseBody = payload; },
    },
    response,
    get responseBody() { return responseBody; },
    body,
  };
}

test('comments-to-office claim retains a text-only DOCX through the route and frozen client', async (t) => {
  const state = await setup(); t.after(() => state.store.dispose());
  const endpoint = createCommentsToOfficeEndpoints({
    json: async (_path, options) => {
      const route = routeContext({ source: state.source, service: state.service, store: state.store });
      assert.equal(options.method, 'POST');
      await handleCommentsToOfficeRoute(route.context);
      return route.responseBody;
    },
  });
  const result = await endpoint.exportCommentsToOffice(state.source.id, {
    sourceSha256: state.source.sha256, revision: 1, selectedIds: null,
  });
  assert.equal(result.kind, 'comments-to-office');
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.artifact));
  const retained = state.store.getArtifact(result.artifact.id);
  const bytes = await readFile(retained.filePath);
  const entries = readZipEntries(bytes);
  assert.deepEqual([...entries.keys()].sort(), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  const xml = entries.get('word/document.xml').toString('utf8');
  assert.match(xml, /Review this paragraph/u);
  assert.doesNotMatch(xml, /comments\.xml|tracked comments|word\/comments/u);
  assert.equal(retained.operation.expected.textOnly, true);
  assert.equal(retained.operation.expected.reviewInteroperability, false);
  await state.store.deleteArtifact(retained.id);
});

test('comments-to-office route forwards revision, signal, rejects forged output, and cleans up disconnects', async (t) => {
  const state = await setup(); t.after(() => state.store.dispose());
  const exported = await state.service.export(state.source.id, {
    sourceSha256: state.source.sha256, revision: 1, selectedIds: null,
  });
  const controller = new AbortController(); controller.abort();
  const disconnected = routeContext({ source: state.source, service: state.service, store: state.store, signal: controller.signal, resultOverride: exported });
  assert.equal(await handleCommentsToOfficeRoute(disconnected.context), true);
  assert.throws(() => state.store.getArtifact(exported.artifact.id), { code: 'ARTIFACT_NOT_FOUND' });

  const forged = structuredClone(exported);
  forged.artifact.operation.expected.reviewInteroperability = true;
  await assert.rejects(handleCommentsToOfficeRoute(routeContext({
    source: state.source, service: state.service, store: state.store, resultOverride: forged,
  }).context), { code: 'COMMENTS_TO_OFFICE_RESULT_INVALID', status: 502 });
  assert.throws(() => state.store.getArtifact(forged.artifact.id), { code: 'ARTIFACT_NOT_FOUND' });
  assert.throws(() => validateCommentsToOfficeResult(forged, {
    documentId: state.source.id, sourceSha256: state.source.sha256,
    request: { sourceSha256: state.source.sha256, revision: 1, selectedIds: null },
  }), { code: 'INVALID_LOCAL_HOST' });
});
