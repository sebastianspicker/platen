import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createAppHandler } from '../scripts/host/router.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { PdfKitMutationService } from '../scripts/host/pdfkit-mutation-service.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { invoke } from './support/host-router-fixture-base.js';
import { createDocumentOverlays } from './support/host-router-fixture-document-overlays.js';
import { PdfKitMutationFixtureAdapter } from './support/pdfkit-mutation-fixture-adapter.js';
import {
  createPdfKitMutationFixturePoppler,
  DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS,
} from './support/pdfkit-mutation-fixture-poppler.js';
import { sourceBytes } from './support/pdfkit-mutation-fixture-data.js';
import { canRunIntegration, directlyEncryptFixture, makeTextPdf, mutationRequest, productPath, runInspection, runMutation, sourceSha256 } from './host-pdfkit-test-support.js';
import { spawnSync } from 'node:child_process';

const TOKEN = 'a'.repeat(64);
const AUTH = Object.freeze({ origin: 'http://127.0.0.1:4173', 'x-platen-token': TOKEN });
const textMutation = Object.freeze({
  metadata: null,
  pageBox: null,
  rotation: null,
  annotations: [{ page: 1, subtype: 'text', contents: 'private sticky review note', rect: { x: 20, y: 100, width: 30, height: 20 } }],
});

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function setup() {
  const root = await mkdtemp('/tmp/review-comments-source-bound-');
  const store = await new DocumentStore({ root }).initialize();
  const document = await store.createDocument({ stream: Readable.from([sourceBytes]), displayName: 'source.pdf' });
  const workspaceState = new WorkspaceStateStore(store);
  const context = { root, sourcePath: store.getSourcePath(document.id), sourceBackup: join(root, 'source.before-swap'), verified: 0, cleaned: false, observed: null, promoted: null, sourceSwapped: false, stagedSourcePath: null, sourceCalls: [] };
  const options = { ...DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS };
  const service = new PdfKitMutationService({
    store,
    poppler: createPdfKitMutationFixturePoppler(context, options),
    adapter: new PdfKitMutationFixtureAdapter(context, options),
  });
  const overlays = createDocumentOverlays();
  const app = createAppHandler({ staticHandler: (_request, response) => response.end('static'), service: overlays.service, conversion: overlays.conversion, inputs: {}, store, workspaceState, pdfkitMutations: service, token: TOKEN, host: '127.0.0.1', port: 4173 });
  const client = new LocalHostClient({
    fetchImpl: async (path, requestOptions = {}) => {
      const response = await invoke(app, { method: requestOptions.method ?? 'GET', url: path, headers: { host: '127.0.0.1:4173', ...AUTH, 'content-type': 'application/json' }, body: requestOptions.body ?? '' });
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    },
  });
  return { root, store, document, service, client, context, app, dispose: async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test('review.comments claim proves the authenticated general PDFKit Text note route/client/service/download lifecycle', async () => {
  const state = await setup();
  try {
    await state.client.bootstrap();
    const result = await state.client.runPdfKitMutation(state.document.id, state.document.sha256, textMutation);
    assert.equal(result.kind, 'pdfkit-structure-mutation');
    assert.equal(result.sourceDigest, state.document.sha256);
    assert.equal(result.appliedEdits, 1);
    assert.equal(result.artifact.documentId, state.document.id);
    assert.equal(result.artifact.operation.inputs[0].sha256, state.document.sha256);
    assert.deepEqual(result.artifact.operation.parameters.annotations, [{ page: 1, subtype: 'text' }]);
    assert.equal(result.evidence.nativeEffectsReopened, true);
    assert.equal(result.evidence.sourceUnchanged, true);

    const artifact = state.store.getArtifact(result.artifact.id);
    const derived = await readFile(artifact.filePath);
    assert.equal(digest(derived), result.artifact.sha256);
    assert.notEqual(result.artifact.sha256, state.document.sha256);
    assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), sourceBytes);
    assert.deepEqual(state.context.observed.request.mutation, textMutation);
    assert.equal(state.context.observed.options.signal instanceof AbortSignal, true);

    const downloaded = await invoke(state.app, { url: `/api/artifacts/${result.artifact.id}`, headers: AUTH });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(downloaded.body, derived);
    const deleted = await invoke(state.app, { method: 'DELETE', url: `/api/artifacts/${result.artifact.id}`, headers: { ...AUTH, 'content-type': 'application/json' } });
    assert.equal(deleted.statusCode, 204);
    assert.throws(() => state.store.getArtifact(result.artifact.id), { code: 'ARTIFACT_NOT_FOUND' });
  } finally {
    await state.dispose();
  }
});

test('review.comments claim rejects stale, multi-category, duplicate, empty, oversized, unsupported, and unsafe requests before native mutation', async () => {
  const state = await setup();
  try {
    await state.client.bootstrap();
    const valid = textMutation;
    await assert.rejects(state.service.mutate(state.document.id, valid, { sourceSha256: '0'.repeat(64), profile: 'macos-pdfkit-derived-v1' }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
    for (const mutation of [
      { ...valid, metadata: { title: 'extra', author: null, subject: null, keywords: null } },
      { ...valid, annotations: [valid.annotations[0], { ...valid.annotations[0], rect: { x: 30, y: 110, width: 20, height: 20 } }] },
      { ...valid, annotations: [{ ...valid.annotations[0], contents: '' }] },
      { ...valid, annotations: [{ ...valid.annotations[0], contents: 'x'.repeat(1_025) }] },
      { ...valid, annotations: [{ ...valid.annotations[0], subtype: 'popup' }] },
    ]) assert.throws(() => state.client.runPdfKitMutation(state.document.id, state.document.sha256, mutation), TypeError);
    assert.equal(state.context.observed, null);

    for (const sourceSafety of ['Encrypted: yes\nForm: none\nJavaScript: no', 'Encrypted: no\nForm: AcroForm\nJavaScript: no', 'Encrypted: no\nForm: none\nJavaScript: yes']) {
      const unsafe = await setup();
      try {
        unsafe.service = new PdfKitMutationService({ store: unsafe.store, poppler: createPdfKitMutationFixturePoppler(unsafe.context, { ...DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS, sourceSafety }), adapter: new PdfKitMutationFixtureAdapter(unsafe.context, DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS) });
        await assert.rejects(unsafe.service.mutate(unsafe.document.id, valid, { sourceSha256: unsafe.document.sha256, profile: 'macos-pdfkit-derived-v1' }), { code: 'PDFKIT_SOURCE_UNSUPPORTED', status: 422 });
      } finally { await unsafe.dispose(); }
    }
  } finally {
    await state.dispose();
  }
});

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--package-path', new URL('../native/pdfkit-helper/', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
});

test('native PDFKit reopen retains exactly one inert Text note and its Popup boundary', { skip: !canRunIntegration() }, async () => {
  const root = await mkdtemp('/tmp/review-comments-native-');
  try {
    const source = makeTextPdf('native sticky-note source');
    const sourcePath = join(root, 'input.pdf');
    await writeFile(sourcePath, source, { mode: 0o600 }); await chmod(root, 0o700);
    const response = await runMutation(root, textMutation);
    assert.equal(response.ok, true);
    assert.equal(response.result.sourceSha256, sourceSha256(source));
    assert.equal(response.result.outputSha256, sourceSha256(await readFile(join(root, 'output.pdf'))));
    assert.equal(response.result.appliedEdits, 1);
    assert.deepEqual((await runInspection(root, 'output.pdf')).response.result.pages[0].annotations.map(({ subtype }) => subtype), ['text', 'popup']);
    const bytes = await readFile(join(root, 'output.pdf'));
    const raw = bytes.toString('latin1');
    assert.match(raw, /\/Subtype\s*\/Text/u); assert.match(raw, /\/Subtype\s*\/Popup/u); assert.doesNotMatch(raw, /\/URI\b|\/GoToR\b|\/Launch\b|\/AA\b/u);
    assert.deepEqual(await readFile(sourcePath), source);

    const rejected = [
      { mutation: textMutation, digest: '0'.repeat(64), code: 'MUTATION_FAILED' },
      { mutation: { ...textMutation, metadata: { title: 'extra', author: null, subject: null, keywords: null } }, code: 'INVALID_REQUEST' },
      { mutation: { ...textMutation, annotations: [textMutation.annotations[0], { ...textMutation.annotations[0], rect: { x: 30, y: 110, width: 20, height: 20 } }] }, code: 'INVALID_REQUEST' },
      { mutation: { ...textMutation, annotations: [{ ...textMutation.annotations[0], contents: '' }] }, code: 'MUTATION_FAILED' },
      { mutation: { ...textMutation, annotations: [{ ...textMutation.annotations[0], contents: 'x'.repeat(1_025) }] }, code: 'INVALID_REQUEST' },
      { mutation: { ...textMutation, annotations: [{ ...textMutation.annotations[0], subtype: 'popup' }] }, code: 'INVALID_REQUEST' },
      { mutation: { ...textMutation, annotations: [{ ...textMutation.annotations[0], rect: { x: 600, y: 700, width: 20, height: 20 } }] }, code: 'MUTATION_FAILED' },
    ];
    for (const entry of rejected) {
      const request = mutationRequest(entry.mutation, entry.digest ?? sourceSha256(source));
      await writeFile(join(root, 'request.json'), JSON.stringify(request), { mode: 0o600 });
      const run = spawnSync(productPath, ['--request', join(root, 'request.json')], { cwd: root, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const envelope = JSON.parse(run.stdout);
      assert.deepEqual(envelope, { version: 1, ok: false, error: { code: entry.code } });
      await rm(join(root, 'output.pdf'), { force: true });
    }

    const encrypted = await directlyEncryptFixture(source);
    try {
      await writeFile(join(encrypted.workspace, 'input.pdf'), encrypted.encrypted, { mode: 0o600 });
      const encryptedResponse = await runMutation(encrypted.workspace, textMutation);
      assert.deepEqual(encryptedResponse, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
      assert.deepEqual(await readFile(join(encrypted.workspace, 'input.pdf')), encrypted.encrypted);
    } finally { await rm(encrypted.workspace, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
