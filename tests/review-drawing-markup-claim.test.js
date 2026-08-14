import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createAppHandler } from '../scripts/host/router.mjs';
import { PdfKitMutationService } from '../scripts/host/pdfkit-mutation-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { PdfKitMutationFixtureAdapter } from './support/pdfkit-mutation-fixture-adapter.js';
import {
  createPdfKitMutationFixturePoppler,
  DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS,
} from './support/pdfkit-mutation-fixture-poppler.js';
import { sourceBytes } from './support/pdfkit-mutation-fixture-data.js';
import { invoke } from './support/host-router-fixture-base.js';
import { createDocumentOverlays } from './support/host-router-fixture-document-overlays.js';
import { LocalHostClient } from '../src/core/local-host-client.js';

const TOKEN = 'a'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'x-platen-token': TOKEN,
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'review-drawing-markup-'));
  const store = await new DocumentStore({ root }).initialize();
  const document = await store.createDocument({
    stream: Readable.from([sourceBytes]), displayName: 'source.pdf',
  });
  const workspaceState = new WorkspaceStateStore(store);
  const context = {
    root,
    sourcePath: store.getSourcePath(document.id),
    sourceBackup: join(root, 'source.before-swap'),
    verified: 0,
    cleaned: false,
    observed: null,
    promoted: null,
    sourceSwapped: false,
    stagedSourcePath: null,
    sourceCalls: [],
  };
  const options = { ...DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS };
  const poppler = createPdfKitMutationFixturePoppler(context, options);
  const adapter = new PdfKitMutationFixtureAdapter(context, options);
  const service = new PdfKitMutationService({ store, poppler, adapter });
  const documentOverlays = createDocumentOverlays();
  const app = createAppHandler({
    staticHandler: (_request, response) => response.end('static'),
    service: documentOverlays.service, conversion: documentOverlays.conversion,
    inputs: {}, store, workspaceState, pdfkitMutations: service,
    token: TOKEN, host: '127.0.0.1', port: 4173,
  });
  const client = new LocalHostClient({
    fetchImpl: async (path, requestOptions = {}) => {
      const requestHeaders = requestOptions.headers ?? {};
      const response = await invoke(app, {
        method: requestOptions.method ?? 'GET',
        url: path,
        headers: {
          host: '127.0.0.1:4173', ...AUTH,
          ...(requestHeaders['Content-Type'] ? { 'content-type': requestHeaders['Content-Type'] } : {}),
          ...(requestHeaders['content-type'] ? { 'content-type': requestHeaders['content-type'] } : {}),
        },
        body: requestOptions.body ?? '',
      });
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    },
  });
  return {
    root, store, document, service, client, context, app,
    dispose: async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

const cases = [
  {
    name: 'straight-line',
    method: 'runPdfKitLineAnnotationMutation',
    profile: 'macos-pdfkit-line-annotation-v1',
    mutation: { line: { page: 1, contents: 'private line', start: { x: 40, y: 50 }, end: { x: 180, y: 210 } } },
    kind: 'pdfkit-line-annotation-mutation',
    category: 'line-annotation',
    evidence: ['lineGeometryVerified', 'fixedLineStylesVerified'],
    validators: ['source-bound-line-annotation', 'line-geometry-reopen', 'fixed-line-styles', 'native-active-content-graph'],
    limitation: 'fixed no-ending styles',
  },
  {
    name: 'open-ink-path',
    method: 'runPdfKitInkAnnotationMutation',
    profile: 'macos-pdfkit-ink-annotation-v1',
    mutation: { ink: { page: 1, contents: 'private ink', points: [{ x: 40, y: 50 }, { x: 90, y: 120 }, { x: 180, y: 210 }] } },
    kind: 'pdfkit-ink-annotation-mutation',
    category: 'ink-annotation',
    evidence: ['inkGeometryVerified', 'rawInkListVerified'],
    validators: ['source-bound-ink-annotation', 'ink-geometry-reopen', 'raw-ink-list', 'native-active-content-graph'],
    limitation: 'fixed appearance',
  },
];

for (const drawing of cases) {
  test(`review.drawing-markup claim proves authenticated ${drawing.name} route/client/service lifecycle`, async () => {
    const state = await setup();
    try {
      await state.client.bootstrap();
      const result = await state.client[drawing.method](
        state.document.id, state.document.sha256, drawing.mutation,
      );
      assert.equal(result.kind, drawing.kind);
      assert.equal(result.sourceDigest, state.document.sha256);
      assert.equal(result.artifact.documentId, state.document.id);
      assert.equal(result.artifact.operation.inputs[0].sha256, state.document.sha256);
      assert.equal(result.artifact.operation.type, drawing.kind);
      assert.equal(result.artifact.operation.parameters.category, drawing.category);
      assert.deepEqual(result.artifact.operation.validation.validators.slice(-4), drawing.validators);
      for (const key of drawing.evidence) assert.equal(result.evidence[key], true);
      assert.equal(result.evidence.nativeEffectsReopened, true);
      assert.equal(result.postflight.reopenVerified, true);
      assert.equal(result.evidence.sourceUnchanged, true);
      assert.match(result.limitations.join(' '), new RegExp(drawing.limitation, 'u'));

      const artifact = state.store.getArtifact(result.artifact.id);
      const derived = await readFile(artifact.filePath);
      assert.equal(sha256(derived), result.artifact.sha256);
      assert.notEqual(result.artifact.sha256, state.document.sha256);
      assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), sourceBytes);
      assert.equal(state.context.observed.request.sourceSha256, state.document.sha256);
      assert.equal(state.context.observed.request.operation, drawing.name === 'straight-line' ? 'addLineAnnotation' : 'addInkAnnotation');
      assert.equal(state.context.observed.options.signal instanceof AbortSignal, true);

      const downloaded = await invoke(state.app, {
        url: `/api/artifacts/${result.artifact.id}`, headers: AUTH,
      });
      assert.equal(downloaded.statusCode, 200);
      assert.deepEqual(downloaded.body, derived);
      const deleted = await invoke(state.app, {
        method: 'DELETE', url: `/api/artifacts/${result.artifact.id}`,
        headers: { ...AUTH, 'content-type': 'application/json' },
      });
      assert.equal(deleted.statusCode, 204);
      assert.throws(() => state.store.getArtifact(result.artifact.id), { code: 'ARTIFACT_NOT_FOUND' });
    } finally {
      await state.dispose();
    }
  });
}

test('review.drawing-markup rejects unsupported action semantics before native mutation', async () => {
  const state = await setup();
  try {
    await state.client.bootstrap();
    const valid = cases[0];
    const rejectedRoute = await invoke(state.app, {
      method: 'POST',
      url: `/api/documents/${state.document.id}/pdfkit-mutation`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: valid.profile, sourceSha256: state.document.sha256,
        mutation: { line: { ...valid.mutation.line, action: 'launch' } },
      }),
    });
    assert.equal(rejectedRoute.statusCode, 400);
    for (const mutation of [
      { line: { ...valid.mutation.line, action: 'launch' } },
      { line: { ...valid.mutation.line, uri: 'https://example.invalid' } },
      { ...valid.mutation, extra: true },
    ]) {
      assert.throws(
        () => state.client.runPdfKitLineAnnotationMutation(state.document.id, state.document.sha256, mutation),
        TypeError,
      );
    }
    assert.equal(state.context.observed, null);
  } finally {
    await state.dispose();
  }
});
