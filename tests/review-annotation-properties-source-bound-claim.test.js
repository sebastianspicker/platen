import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { spawnSync } from 'node:child_process';

import { createAppHandler } from '../scripts/host/router.mjs';
import { PdfKitMutationService } from '../scripts/host/pdfkit-mutation-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { invoke } from './support/host-router-fixture-base.js';
import { createDocumentOverlays } from './support/host-router-fixture-document-overlays.js';
import {
  canRunIntegration,
  directlyEncryptFixture,
  deriveTargetedSanitizationSource,
  makeLocatorPdf,
  packagePath,
  projectPath,
  productPath,
  PDFKitAdapter,
  PopplerAdapter,
  EngineRegistry,
  stagePdfKitHelper,
  verifyStagedPdfKitHelper,
  createProcessLimiter,
  makeTargetedSanitizationPdf,
  runInspection,
  runTargetedMutation,
  sourceSha256,
  targetedMutationRequest,
} from './host-pdfkit-test-support.js';
import { parseClassicPdfAnnotationPages } from './support/classic-pdf-annotation-parser.js';
import { PdfKitMutationFixtureAdapter } from './support/pdfkit-mutation-fixture-adapter.js';
import { createPdfKitMutationFixturePoppler, DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS } from './support/pdfkit-mutation-fixture-poppler.js';
import { sourceBytes as fixtureSourceBytes } from './support/pdfkit-mutation-fixture-data.js';

const TOKEN = 'a'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'x-platen-token': TOKEN,
});
const CAN_RUN = canRunIntegration();

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function annotationPdf({ targetSubtype = 'FreeText', targetExtra = '', popup = false } = {}) {
  const popupObject = popup
    ? '<< /Type /Annot /Subtype /Popup /Rect [300 550 360 590] /Parent 8 0 R /P 3 0 R >>'
    : null;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R /Annots [8 0 R 9 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R /Annots [10 0 R] >>',
    '<< /Length 47 >>\nstream\nBT /F1 18 Tf 72 720 Td (one) Tj ET\nendstream',
    '<< /Length 47 >>\nstream\nBT /F1 18 Tf 72 720 Td (two) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Annot /Subtype /${targetSubtype} /Contents (private target contents) /DA (/F1 12 Tf 0 g) /Rect [72 550 300 590] /P 3 0 R${targetExtra}${popup ? ' /Popup 11 0 R' : ''} >>`,
    '<< /Type /Annot /Subtype /Circle /Contents (private retained circle) /Rect [320 550 500 620] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Square /Contents (private retained square) /Rect [72 550 300 620] /P 4 0 R >>',
    ...(popupObject ? [popupObject] : []),
  ];
  let body = '%PDF-1.7\n%\xFF\xFF\xFF\xFF\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += `${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function productionContext(t, source = annotationPdf()) {
  if (!CAN_RUN) t.skip('Installed PDFKit helper integration tooling is unavailable.');
  const root = await mkdtemp(join(tmpdir(), 'platen-annotation-properties-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const store = await new DocumentStore({ root: join(root, 'store') }).initialize();
  const context = { root, sourcePath: '', sourceBackup: join(root, 'source.before-swap'), verified: 0, cleaned: false, observed: null, promoted: null, sourceSwapped: false, stagedSourcePath: null, sourceCalls: [] };
  const options = { ...DEFAULT_PDFKIT_MUTATION_FIXTURE_OPTIONS };
  const service = new PdfKitMutationService({ store, poppler: createPdfKitMutationFixturePoppler(context, options), adapter: new PdfKitMutationFixtureAdapter(context, options) });
  const document = await store.createDocument({ stream: Readable.from([fixtureSourceBytes]), displayName: 'annotation-source.pdf' });
  const workspaceState = new WorkspaceStateStore(store);
  const overlays = createDocumentOverlays();
  const app = createAppHandler({
    staticHandler: (_request, response) => response.end('static'),
    service: overlays.service,
    conversion: overlays.conversion,
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
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode, headers: response.headers,
      });
    },
  });
  return { root, source: fixtureSourceBytes, store, document, client, app, context };
}

async function nativeReject(t, source, mutation) {
  const workspace = await mkdtemp(join(tmpdir(), 'platen-annotation-properties-reject-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await chmod(workspace, 0o700);
  await writeFile(join(workspace, 'input.pdf'), source, { mode: 0o600 });
  const inspected = await runInspection(workspace);
  const response = await runTargetedMutation(workspace, targetedMutationRequest(sourceSha256(source), mutation));
  return { workspace, inspected: inspected.response.result, response };
}

before({ skip: !CAN_RUN }, () => {
  const debugBuild = spawnSync(
    'swift', ['build', '--package-path', packagePath], { encoding: 'utf8' },
  );
  assert.equal(debugBuild.status, 0, debugBuild.stderr);
  const build = spawnSync(
    'swift', ['build', '-c', 'release', '--package-path', packagePath], { encoding: 'utf8' },
  );
  assert.equal(build.status, 0, build.stderr);
});

test('authenticated annotation-properties claim updates one exact source-bound annotation and retains a derived artifact', async (t) => {
  const source = annotationPdf();
  const state = await productionContext(t, source);
  const nativeInspectionWorkspace = await mkdtemp(join(tmpdir(), 'platen-annotation-properties-valid-'));
  t.after(() => rm(nativeInspectionWorkspace, { recursive: true, force: true }));
  await chmod(nativeInspectionWorkspace, 0o700);
  await writeFile(join(nativeInspectionWorkspace, 'input.pdf'), source, { mode: 0o600 });
  const nativeBefore = (await runInspection(nativeInspectionWorkspace)).response.result;
  const nativeTarget = nativeBefore.pages[0].annotations.find(({ subtype }) => subtype === 'freeText');
  const nativeMutation = {
    formFill: null,
    annotationUpdate: {
      page: 1, annotationIndex: nativeTarget.annotationIndex, fingerprint: nativeTarget.fingerprint,
      subtype: 'freeText', contents: 'updated target contents', rect: { x: 100, y: 520, width: 220, height: 50 },
    },
    annotationProperties: null,
    annotationRemove: null,
  };
  const direct = await nativeReject(t, source, nativeMutation);
  assert.equal(direct.response.response.ok, true);
  const nativeDerived = await readFile(join(direct.workspace, 'output.pdf'));
  const nativeBeforeRaw = parseClassicPdfAnnotationPages(source);
  const nativeAfterRaw = parseClassicPdfAnnotationPages(nativeDerived);
  const semantic = ({ subtype, rect, contentsSha256 }) => ({ subtype, rect, contentsSha256 });
  assert.deepEqual(nativeAfterRaw[0].filter((_entry, index) => index !== nativeTarget.annotationIndex).map(semantic), nativeBeforeRaw[0].filter((_entry, index) => index !== nativeTarget.annotationIndex).map(semantic));
  assert.deepEqual(nativeAfterRaw[1].map(semantic), nativeBeforeRaw[1].map(semantic));
  assert.equal(nativeAfterRaw[0][nativeTarget.annotationIndex].rect.join(','), '100,520,320,570');
  assert.equal(nativeAfterRaw[0][nativeTarget.annotationIndex].contentsSha256, digest(Buffer.from('updated target contents')));
  assert.deepEqual(await readFile(join(nativeInspectionWorkspace, 'input.pdf')), source);
  assert.deepEqual(await readFile(join(direct.workspace, 'input.pdf')), source);
  await state.client.bootstrap();
  const target = { page: 1, annotationIndex: 0, fingerprint: 'a'.repeat(64), subtype: 'freeText' };
  const mutation = {
    formFill: null,
    annotationUpdate: {
      page: 1, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint,
      subtype: 'freeText', contents: 'updated target contents',
      rect: { x: 100, y: 520, width: 220, height: 50 },
    },
    annotationProperties: null,
    annotationRemove: null,
  };
  const result = await state.client.runPdfKitTargetedMutation(
    state.document.id, state.document.sha256, mutation,
  );
  assert.equal(result.kind, 'pdfkit-targeted-mutation');
  assert.equal(result.sourceDigest, state.document.sha256);
  assert.equal(result.appliedEdits, 1);
  assert.equal(result.artifact.operation.type, 'pdfkit-targeted-mutation');
  assert.deepEqual(result.artifact.operation.parameters, {
    category: 'annotation-update', page: 1, annotationIndex: target.annotationIndex, subtype: 'freeText',
  });
  assert.deepEqual(result.artifact.operation.inputs, [{ documentId: state.document.id, sha256: state.document.sha256, role: 'source' }]);
  assert.equal(result.evidence.nativeEffectsReopened, true);
  assert.equal(result.evidence.sourceUnchanged, true);
  assert.equal(result.artifact.operation.validation.validators.includes('source-bound-annotation-locator'), true);
  assert.equal(result.artifact.operation.validation.validators.includes('native-active-content-graph'), true);

  const retained = state.store.getArtifact(result.artifact.id);
  const derived = await readFile(retained.filePath);
  assert.equal(digest(derived), result.artifact.sha256);
  assert.notEqual(result.artifact.sha256, state.document.sha256);
  assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), state.source);

  assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), fixtureSourceBytes);

  const downloaded = await invoke(state.app, { url: `/api/artifacts/${result.artifact.id}`, headers: AUTH });
  assert.equal(downloaded.statusCode, 200);
  assert.deepEqual(downloaded.body, derived);
  const deleted = await invoke(state.app, {
    method: 'DELETE', url: `/api/artifacts/${result.artifact.id}`,
    headers: { ...AUTH, 'content-type': 'application/json' },
  });
  assert.equal(deleted.statusCode, 204);
  assert.throws(() => state.store.getArtifact(result.artifact.id), { code: 'ARTIFACT_NOT_FOUND' });
});

test('authenticated client route retains one independently inspected Square property artifact from the staged release helper', {
  skip: !CAN_RUN, timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-annotation-properties-release-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const seed = await mkdtemp(join(root, 'seed-'));
  await chmod(seed, 0o700);
  await writeFile(join(seed, 'input.pdf'), makeTargetedSanitizationPdf(), { mode: 0o600 });
  const source = await deriveTargetedSanitizationSource(seed);
  const inspectedSource = await runInspection(seed);
  const target = inspectedSource.response.result.pages[1].annotations.find(({ subtype }) => subtype === 'square');
  assert.ok(target);

  const store = await new DocumentStore({ root: join(root, 'store') }).initialize();
  t.after(() => store.dispose());
  const staged = await stagePdfKitHelper({ root: projectPath, sessionRoot: root });
  assert.equal(staged.available, true);
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
  const registry = new EngineRegistry({ runner });
  const service = new PdfKitMutationService({
    store,
    poppler: new PopplerAdapter({ registry, runner }),
    adapter: new PDFKitAdapter({
      executable: staged.executable, expectedSha256: staged.sha256,
      verifyExecutable: verifyStagedPdfKitHelper, runner,
    }),
  });
  const document = await store.createDocument({
    stream: Readable.from([source]), displayName: 'square-source.pdf', mediaType: 'application/pdf',
  });
  const overlays = createDocumentOverlays();
  const app = createAppHandler({
    staticHandler: (_request, response) => response.end('static'),
    service: overlays.service,
    conversion: overlays.conversion,
    inputs: {}, store, workspaceState: new WorkspaceStateStore(store), pdfkitMutations: service,
    token: TOKEN, host: '127.0.0.1', port: 4173,
  });
  const client = new LocalHostClient({
    fetchImpl: async (path, requestOptions = {}) => {
      const headers = requestOptions.headers ?? {};
      const response = await invoke(app, {
        method: requestOptions.method ?? 'GET', url: path,
        headers: {
          host: '127.0.0.1:4173', ...AUTH,
          ...(headers['Content-Type'] ? { 'content-type': headers['Content-Type'] } : {}),
        },
        body: requestOptions.body ?? '',
      });
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode, headers: response.headers,
      });
    },
  });
  await client.bootstrap();
  const mutation = {
    formFill: null, annotationUpdate: null, annotationRemove: null,
    annotationProperties: {
      page: 2, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint,
      subtype: 'square', rect: { x: 84, y: 540, width: 196, height: 52 }, strokeColor: '#12abef',
    },
  };
  const result = await client.runPdfKitTargetedMutation(document.id, document.sha256, mutation);
  assert.equal(result.artifact.operation.parameters.category, 'annotation-properties');
  assert.equal(result.evidence.rawAnnotationColorVerified, true);
  assert.doesNotMatch(JSON.stringify(result), /12abef|fingerprint|filePath/);
  assert.deepEqual(await readFile(store.getSourcePath(document.id)), source);

  const retained = store.getArtifact(result.artifact.id);
  const retainedBytes = await readFile(retained.filePath);
  assert.equal(digest(retainedBytes), result.artifact.sha256);
  const inspectionWorkspace = await mkdtemp(join(root, 'retained-inspection-'));
  await chmod(inspectionWorkspace, 0o700);
  await writeFile(join(inspectionWorkspace, 'output.pdf'), retainedBytes, { mode: 0o600 });
  const independentlyInspected = await runInspection(inspectionWorkspace, 'output.pdf');
  const square = independentlyInspected.response.result.pages[1].annotations.find(({ subtype }) => subtype === 'square');
  assert.equal(square.annotationIndex, target.annotationIndex);

  await client.deleteArtifact(result.artifact.id);
  assert.throws(() => store.getArtifact(result.artifact.id), { code: 'ARTIFACT_NOT_FOUND' });
});

test('native annotation-properties targeting rejects stale or mismatched source locators and unsafe annotation graphs', { skip: !CAN_RUN }, async (t) => {
  const source = annotationPdf();
  const inspected = (await nativeReject(t, source, {
    formFill: null,
    annotationUpdate: {
      page: 1, annotationIndex: 0, fingerprint: '0'.repeat(64), subtype: 'freeText',
      contents: 'updated', rect: { x: 100, y: 520, width: 220, height: 50 },
    },
    annotationProperties: null,
    annotationRemove: null,
  })).inspected;
  const target = inspected.pages[0].annotations[0];
  const validUpdate = (overrides = {}) => ({
    formFill: null,
    annotationUpdate: {
      page: 1, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint,
      subtype: 'freeText', contents: 'updated', rect: { x: 100, y: 520, width: 220, height: 50 }, ...overrides,
    },
    annotationProperties: null,
    annotationRemove: null,
  });
  for (const mutation of [
    validUpdate({ fingerprint: '0'.repeat(64) }),
    validUpdate({ subtype: 'square' }),
    validUpdate({ page: 2 }),
    validUpdate({ annotationIndex: 1 }),
    validUpdate({ contents: 'private target contents', rect: { x: 72, y: 550, width: 228, height: 40 } }),
  ]) {
    const result = await nativeReject(t, source, mutation);
    assert.deepEqual(result.response.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  }

  for (const mutation of [
    validUpdate({ contents: '' }),
    validUpdate({ contents: 'x'.repeat(1_025) }),
    validUpdate({ rect: { x: 100, y: 520, width: 0, height: 50 } }),
  ]) {
    const result = await nativeReject(t, source, mutation);
    assert.deepEqual(result.response.response, { version: 1, ok: false, error: { code: 'INVALID_REQUEST' } });
  }

  for (const unsafe of [
    annotationPdf({ targetExtra: ' /A << /S /URI /URI (https://example.invalid) >>' }),
    annotationPdf({ targetExtra: ' /AA << /E << /S /URI /URI (https://example.invalid) >> >>' }),
    annotationPdf({ targetSubtype: 'Popup' }),
  ]) {
    const targetInfo = (await nativeReject(t, unsafe, validUpdate())).inspected.pages[0].annotations[0];
    const result = await nativeReject(t, unsafe, validUpdate({ fingerprint: targetInfo.fingerprint }));
    assert.deepEqual(result.response.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
  }

  const textSource = annotationPdf({ targetSubtype: 'Text' });
  const textInfo = (await nativeReject(t, textSource, validUpdate())).inspected.pages[0].annotations[0];
  const textResult = await nativeReject(t, textSource, validUpdate({ fingerprint: textInfo.fingerprint }));
  assert.deepEqual(textResult.response.response, { version: 1, ok: false, error: { code: 'MUTATION_FAILED' } });
});

test('native annotation-properties targeting rejects encrypted, locked, and signed source fixtures', { skip: !CAN_RUN }, async (t) => {
  const encryptedFixture = await directlyEncryptFixture(annotationPdf());
  const encryptedSource = encryptedFixture.encrypted;
  const encrypted = await nativeReject(t, encryptedSource, {
    formFill: null,
    annotationUpdate: {
      page: 1, annotationIndex: 0, fingerprint: '0'.repeat(64), subtype: 'freeText',
      contents: 'updated', rect: { x: 100, y: 520, width: 220, height: 50 },
    },
    annotationProperties: null,
    annotationRemove: null,
  });
  assert.equal(encrypted.response.response.ok, false);

  const signedSource = makeLocatorPdf({ withSignature: true });
  const signedInspection = (await nativeReject(t, signedSource, {
    formFill: null,
    annotationUpdate: {
      page: 1, annotationIndex: 2, fingerprint: '0'.repeat(64), subtype: 'freeText',
      contents: 'updated', rect: { x: 100, y: 520, width: 220, height: 50 },
    },
    annotationProperties: null,
    annotationRemove: null,
  })).inspected;
  const signedTarget = signedInspection.pages[0].annotations.find(({ subtype }) => subtype === 'freeText');
  const signed = await nativeReject(t, signedSource, {
    formFill: null,
    annotationUpdate: {
      page: 1, annotationIndex: signedTarget.annotationIndex, fingerprint: signedTarget.fingerprint,
      subtype: 'freeText', contents: 'updated', rect: { x: 100, y: 520, width: 220, height: 50 },
    },
    annotationProperties: null,
    annotationRemove: null,
  });
  assert.equal(signed.response.response.ok, false);
});
