import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

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
import {
  canRunIntegration,
  makeTextPdf,
  mutationRequest,
  productPath,
  runInspection,
  runMutation,
  sourceSha256,
} from './host-pdfkit-test-support.js';
import { parseClassicPdfAnnotationPages } from './support/classic-pdf-annotation-parser.js';

const TOKEN = 'a'.repeat(64);
const AUTH = Object.freeze({ origin: 'http://127.0.0.1:4173', 'x-platen-token': TOKEN });
const RECT = Object.freeze({ x: 40, y: 120, width: 140, height: 36 });
const CASES = Object.freeze([
  { claim: 'review.markup-tools', subtype: 'highlight', contents: 'highlight source-bound span' },
  { claim: 'review.text-notes-callouts', subtype: 'freeText', contents: 'freetext source-bound box' },
  { claim: 'review.text-markup', subtype: 'underline', contents: 'underline source-bound span' },
]);

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mutationFor(entry) {
  return {
    metadata: null,
    pageBox: null,
    rotation: null,
    annotations: [{ page: 1, subtype: entry.subtype, contents: entry.contents, rect: { ...RECT } }],
  };
}

async function setup(optionsOverrides = {}) {
  const root = await mkdtemp('/tmp/review-markup-text-source-bound-');
  const store = await new DocumentStore({ root }).initialize();
  const document = await store.createDocument({ stream: Readable.from([sourceBytes]), displayName: 'source.pdf' });
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
  const options = { ...DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS, ...optionsOverrides };
  const service = new PdfKitMutationService({
    store,
    poppler: createPdfKitMutationFixturePoppler(context, options),
    adapter: new PdfKitMutationFixtureAdapter(context, options),
  });
  const overlays = createDocumentOverlays();
  const app = createAppHandler({
    staticHandler: (_request, response) => response.end('static'),
    service: overlays.service,
    conversion: overlays.conversion,
    inputs: {},
    store,
    workspaceState,
    pdfkitMutations: service,
    token: TOKEN,
    host: '127.0.0.1',
    port: 4173,
  });
  const client = new LocalHostClient({
    fetchImpl: async (path, requestOptions = {}) => {
      const response = await invoke(app, {
        method: requestOptions.method ?? 'GET',
        url: path,
        headers: { host: '127.0.0.1:4173', ...AUTH, 'content-type': 'application/json' },
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

for (const entry of CASES) {
  test(`${entry.claim} is one inert ${entry.subtype} source-bound derived artifact`, async () => {
    const state = await setup();
    const mutation = mutationFor(entry);
    try {
      await state.client.bootstrap();
      const result = await state.client.runPdfKitMutation(
        state.document.id, state.document.sha256, mutation,
      );
      assert.equal(result.kind, 'pdfkit-structure-mutation');
      assert.equal(result.sourceDigest, state.document.sha256);
      assert.equal(result.appliedEdits, 1);
      assert.equal(result.evidence.nativeEffectsReopened, true);
      assert.equal(result.evidence.sourceUnchanged, true);
      assert.equal(result.artifact.documentId, state.document.id);
      assert.deepEqual(result.artifact.operation.inputs, [{
        documentId: state.document.id, sha256: state.document.sha256, role: 'source',
      }]);
      assert.deepEqual(result.artifact.operation.parameters.annotations, [{ page: 1, subtype: entry.subtype }]);
      assert.equal(result.artifact.operation.validation.passed, true);
      assert.equal(result.artifact.operation.validation.outputSha256, result.artifact.sha256);
      assert.equal(result.artifact.operation.validation.validators.includes('source-sha256'), true);
      assert.equal(result.artifact.operation.validation.validators.includes('pdfkit-effect-reopen'), true);
      assert.doesNotMatch(JSON.stringify(result.artifact.operation), new RegExp(`${entry.contents}|${state.root}`, 'u'));

      const artifact = state.store.getArtifact(result.artifact.id);
      const derived = await readFile(artifact.filePath);
      assert.equal(digest(derived), result.artifact.sha256);
      assert.notEqual(result.artifact.sha256, state.document.sha256);
      assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), sourceBytes);
      assert.deepEqual(state.context.observed.request.mutation, mutation);
      assert.deepEqual(Object.keys(state.context.observed.request.mutation.annotations[0]).sort(), ['contents', 'page', 'rect', 'subtype']);
      assert.equal(state.context.observed.options.signal instanceof AbortSignal, true);

      const downloaded = await invoke(state.app, { url: `/api/artifacts/${result.artifact.id}`, headers: AUTH });
      assert.equal(downloaded.statusCode, 200);
      assert.deepEqual(downloaded.body, derived);
      const deleted = await invoke(state.app, {
        method: 'DELETE',
        url: `/api/artifacts/${result.artifact.id}`,
        headers: { ...AUTH, 'content-type': 'application/json' },
      });
      assert.equal(deleted.statusCode, 204);
      assert.throws(() => state.store.getArtifact(result.artifact.id), { code: 'ARTIFACT_NOT_FOUND' });
    } finally {
      await state.dispose();
    }
  });
}

test('review markup text source-bound mutations reject active, signed, encrypted, and form inputs through shared gates', async () => {
  const valid = mutationFor(CASES[0]);
  const cases = [
    { sourceSafety: 'Encrypted: yes\nForm: none\nJavaScript: no', code: 'PDFKIT_SOURCE_UNSUPPORTED' },
    { sourceSafety: 'Encrypted: no\nForm: AcroForm\nJavaScript: no', code: 'PDFKIT_SOURCE_UNSUPPORTED' },
    { sourceSafety: 'Encrypted: no\nForm: none\nJavaScript: yes', code: 'PDFKIT_SOURCE_UNSUPPORTED' },
    {
      signatureOutput: '  - Total document signed\n  - Signature Validation: Signature is Valid.\n',
      code: 'PDFKIT_SIGNED_SOURCE_UNSUPPORTED',
    },
  ];
  for (const entry of cases) {
    const state = await setup(entry);
    try {
      await assert.rejects(
        state.service.mutate(state.document.id, valid, {
          sourceSha256: state.document.sha256,
          profile: 'macos-pdfkit-derived-v1',
        }),
        { code: entry.code, status: 422 },
      );
      assert.equal(state.context.observed, null);
    } finally {
      await state.dispose();
    }
  }
});

test('review markup text source-bound mutations cancel before promotion and reject forged helper receipts', async () => {
  const cancelled = await setup();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(cancelled.service.mutate(
      cancelled.document.id,
      mutationFor(CASES[1]),
      { sourceSha256: cancelled.document.sha256, profile: 'macos-pdfkit-derived-v1', signal: controller.signal },
    ), { code: 'JOB_CANCELLED', status: 499 });
    assert.equal(cancelled.context.promoted, null);
  } finally {
    await cancelled.dispose();
  }

  const forged = await setup({ mutationReceiptOverride: { outputSha256: '0'.repeat(64) } });
  try {
    await assert.rejects(forged.service.mutate(
      forged.document.id,
      mutationFor(CASES[2]),
      { sourceSha256: forged.document.sha256, profile: 'macos-pdfkit-derived-v1' },
    ), { code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502 });
    assert.equal(forged.context.promoted, null);
  } finally {
    await forged.dispose();
  }
});

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--package-path', new URL('../native/pdfkit-helper/', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
});

for (const entry of CASES) {
  test(`native PDFKit reopen retains one inert ${entry.subtype} with exact contents digest and bounds`, { skip: !canRunIntegration() }, async () => {
    const root = await mkdtemp('/tmp/review-markup-text-native-');
    const mutation = mutationFor(entry);
    const source = makeTextPdf(`${entry.claim} native source`);
    try {
      await chmod(root, 0o700);
      await writeFile(join(root, 'input.pdf'), source, { mode: 0o600 });
      const response = await runMutation(root, mutation);
      assert.equal(response.ok, true);
      assert.equal(response.result.sourceSha256, sourceSha256(source));
      assert.equal(response.result.appliedEdits, 1);
      const reopened = await runInspection(root, 'output.pdf');
      const annotations = reopened.response.result.pages[0].annotations;
      assert.equal(annotations.filter(({ subtype }) => subtype === entry.subtype).length, 1);
      assert.deepEqual(annotations.map(({ subtype }) => subtype), [entry.subtype]);
      const raw = parseClassicPdfAnnotationPages(await readFile(join(root, 'output.pdf')))[0];
      assert.deepEqual(raw.map(({ subtype, rect, flags, contentsSha256 }) => ({
        subtype, rect, flags, contentsSha256,
      })), [{
        subtype: entry.subtype === 'freeText' ? 'FreeText' : entry.subtype[0].toUpperCase() + entry.subtype.slice(1),
        rect: [RECT.x, RECT.y, RECT.x + RECT.width, RECT.y + RECT.height],
        flags: 4,
        contentsSha256: digest(Buffer.from(entry.contents)),
      }]);
      assert.deepEqual(await readFile(join(root, 'input.pdf')), source);
      assert.doesNotMatch(JSON.stringify(response), /\/tmp\/review-markup-text-native-/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
