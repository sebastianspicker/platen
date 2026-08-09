import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runAccessibilityMetadataCommand } from '../scripts/cli/commands/accessibility-metadata.mjs';
import { handleIncrementalAccessibilityMetadataRoute } from '../scripts/host/routes/incremental-accessibility-metadata-routes.mjs';
import { PdfIncrementalAccessibilityMetadataService } from '../scripts/host/pdf-incremental-accessibility-metadata-service.mjs';
import {
  INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS,
  INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS,
  INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE,
  INCREMENTAL_ACCESSIBILITY_METADATA_VALIDATORS,
} from '../src/core/pdf-incremental-accessibility-metadata-contract.js';
import { makeTextPdf } from './pdf-fixture.js';

const documentId = '11111111-1111-4111-8111-111111111111';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function serviceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'platen-accessibility-document-language-title-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = makeTextPdf('Passive accessibility metadata source');
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const sourceSha256 = digest(sourceBytes);
  const calls = [];
  const deleted = [];
  let retained = null;
  const store = {
    getDocument: () => ({
      id: documentId,
      sha256: sourceSha256,
      size: sourceBytes.length,
      displayName: 'source.pdf',
      mediaType: 'application/pdf',
    }),
    getSourcePath: () => sourcePath,
    verifySource: async () => {
      assert.equal(digest(await readFile(sourcePath)), sourceSha256);
    },
    createJobWorkspace: async () => {
      const path = await mkdtemp(join(root, 'job-'));
      await chmod(path, 0o700);
      return path;
    },
    cleanupJob: (path) => rm(path, { recursive: true, force: true }),
    promotePdfArtifact: async (_id, outputPath, options) => {
      const bytes = await readFile(outputPath);
      assert.equal(digest(bytes), options.expectedSha256);
      const filePath = join(root, 'retained.pdf');
      await copyFile(outputPath, filePath);
      retained = {
        id: '22222222-2222-4222-8222-222222222222',
        documentId,
        displayName: 'source-language-title-updated.pdf',
        mediaType: 'application/pdf',
        size: bytes.length,
        sha256: options.expectedSha256,
        filePath,
        operation: options.operation,
      };
      return retained;
    },
    deleteArtifact: async (id) => { deleted.push(id); },
  };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(24).fill(0)]);
  const poppler = {
    async execute(operation, parameters) {
      calls.push({ operation, parameters });
      const output = parameters.input.endsWith('output.pdf');
      if (operation === 'inspect') return { stdout: `Title: ${output ? 'Accessible title' : ''}\nPages: 1\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\n`, stderr: '' };
      if (operation === 'inspectMetadata') return { stdout: '', stderr: '' };
      if (operation === 'inspectCustomMetadata') return { stdout: '', stderr: '' };
      if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '' };
      if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '' };
      if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '' };
      if (operation === 'inspectPageBoxes') return { stdout: 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\n', stderr: '' };
      if (operation === 'extractText') return { stdout: 'Passive accessibility metadata source\f', stderr: '' };
      if (operation === 'renderPagePng') {
        await writeFile(`${parameters.outputPrefix}.png`, png, { mode: 0o600 });
        return { stdout: '', stderr: '' };
      }
      assert.fail(`Unexpected Poppler operation: ${operation}`);
    },
  };
  return {
    root,
    sourceBytes,
    sourceSha256,
    calls,
    deleted,
    store,
    poppler,
    get retained() { return retained; },
  };
}

test('document language/title claim binds source, retained output, and semantic evidence', async (t) => {
  const fixture = await serviceFixture(t);
  const service = new PdfIncrementalAccessibilityMetadataService({ store: fixture.store, poppler: fixture.poppler });
  const result = await service.update(documentId, { language: 'EN-Latn-US', title: 'Accessible title' }, { sourceSha256: fixture.sourceSha256 });

  assert.equal(result.kind, 'pdf-incremental-accessibility-metadata');
  assert.equal(result.sourceDigest, fixture.sourceSha256);
  assert.equal(result.metadata.profile, INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE);
  assert.deepEqual(result.metadata.updatedFields, INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS);
  assert.equal(result.evidence.sourceDigestReverified, true);
  assert.equal(result.evidence.sourcePrefixPreserved, true);
  assert.equal(result.evidence.appendOnlyHistoryRetained, true);
  assert.equal(result.evidence.rawLanguageAndTitleMatched, true);
  assert.equal(result.evidence.pageTextMatched, true);
  assert.equal(result.evidence.pageGeometryMatched, true);
  assert.equal(result.evidence.pageRendersMatched, true);
  assert.equal(result.evidence.outputUnsigned, true);
  assert.equal(result.evidence.artifactDigestBound, true);
  assert.deepEqual(result.artifact.operation.inputs, [{ documentId, sha256: fixture.sourceSha256, role: 'source' }]);
  assert.deepEqual(result.artifact.operation.parameters.updatedFields, ['documentDefaultLanguage', 'infoTitle']);
  assert.deepEqual(result.artifact.operation.validation.validators, [...INCREMENTAL_ACCESSIBILITY_METADATA_VALIDATORS]);
  assert.equal(result.artifact.operation.validation.outputSha256, result.artifact.sha256);

  const retainedBytes = await readFile(fixture.retained.filePath);
  assert.equal(digest(retainedBytes), fixture.retained.sha256);
  assert.equal(retainedBytes.subarray(0, fixture.sourceBytes.length).equals(fixture.sourceBytes), true);
  const latin1 = retainedBytes.toString('latin1');
  assert.match(latin1, /\/Lang <FEFF0065006E002D006C00610074006E002D00750073>/u);
  assert.match(latin1, /\/Title <FEFF00410063006300650073007300690062006C00650020007400690074006C0065>/u);
  assert.ok(fixture.calls.some(({ operation }) => operation === 'inspect'));
  assert.ok(fixture.calls.some(({ operation }) => operation === 'inspectPageBoxes'));
  assert.ok(fixture.calls.some(({ operation }) => operation === 'extractText'));
  assert.ok(fixture.calls.some(({ operation }) => operation === 'renderPagePng'));
  assert.deepEqual(fixture.deleted, []);

  await assert.rejects(
    service.update(documentId, { language: 'en-us', title: 'Accessible title' }, { sourceSha256: '0'.repeat(64) }),
    { code: 'SOURCE_VERSION_MISMATCH', status: 409 },
  );
});

function routeFixture({ body, url = `http://local.test/api/documents/${documentId}/incremental-accessibility-metadata`, destroyed = false } = {}) {
  const response = new EventEmitter();
  response.writableEnded = false;
  response.destroyed = destroyed;
  const calls = [];
  const deleted = [];
  return {
    response,
    calls,
    deleted,
    context: {
      operation: 'incremental-accessibility-metadata',
      request: { method: 'POST' },
      response,
      url: new URL(url),
      documentId,
      processing: { signal: new AbortController().signal },
      store: { deleteArtifact: async (id) => deleted.push(id) },
      incrementalAccessibilityMetadata: {
        update: async (...args) => {
          calls.push(args);
          return { kind: 'pdf-incremental-accessibility-metadata', artifact: { id: 'artifact' } };
        },
      },
      bodyLimit: 2_048,
      exactJsonObject: (value, keys) => Boolean(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
      method: () => {},
      readJson: async () => body,
      json: (_response, status, value) => { response.status = status; response.value = value; },
    },
  };
}

test('document language/title route enforces exact digest-bound request and disconnect cleanup', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const fixture = routeFixture({ body: { profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, sourceSha256, metadata: { language: 'EN-Latn-US', title: 'Accessible PDF' } } });
  assert.equal(await handleIncrementalAccessibilityMetadataRoute(fixture.context), true);
  assert.equal(fixture.response.status, 201);
  assert.deepEqual(fixture.calls[0], [documentId, { language: 'en-latn-us', title: 'Accessible PDF' }, { sourceSha256, signal: fixture.context.processing.signal }]);

  const malformed = routeFixture({ body: { profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, sourceSha256, metadata: { language: 'en', title: 'Accessible PDF' }, extra: true } });
  await assert.rejects(handleIncrementalAccessibilityMetadataRoute(malformed.context), { code: 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OPTIONS' });
  assert.equal(malformed.calls.length, 0);

  const disconnected = routeFixture({ body: { profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, sourceSha256, metadata: { language: 'en', title: 'Accessible PDF' } }, destroyed: true });
  assert.equal(await handleIncrementalAccessibilityMetadataRoute(disconnected.context), true);
  assert.deepEqual(disconnected.deleted, ['artifact']);
});

test('document language/title CLI copies only the validated artifact and revokes on failure', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const outputSha256 = 'b'.repeat(64);
  const artifactId = '22222222-2222-4222-8222-222222222222';
  const artifact = {
    id: artifactId,
    documentId,
    displayName: 'source-language-title-updated.pdf',
    mediaType: 'application/pdf',
    size: 128,
    sha256: outputSha256,
    createdAt: '2026-07-21T00:00:00.000Z',
    operation: {
      schemaVersion: 1,
      id: '33333333-3333-4333-8333-333333333333',
      type: 'pdf-incremental-accessibility-metadata',
      inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
      parameters: {
        profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE,
        updatedFields: ['documentDefaultLanguage', 'infoTitle'],
        requestSha256: digest(Buffer.from(JSON.stringify({ language: 'en-us', title: 'Accessible PDF' }))),
      },
      expected: { pageCount: 1, sourceUnchanged: true, sourcePrefixPreserved: true, rasterized: false },
      validation: {
        passed: true,
        validators: [...INCREMENTAL_ACCESSIBILITY_METADATA_VALIDATORS],
        pageCount: 1,
        outputSha256,
      },
      completedAt: '2026-07-21T00:00:00.000Z',
    },
  };
  const result = {
    kind: 'pdf-incremental-accessibility-metadata',
    sourceDigest: sourceSha256,
    artifact,
    metadata: { profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, updatedFields: ['documentDefaultLanguage', 'infoTitle'], requestSha256: digest(Buffer.from(JSON.stringify({ language: 'en-us', title: 'Accessible PDF' }))) },
    evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, appendOnlyHistoryRetained: true, rawLanguageAndTitleMatched: true, outputUnsigned: true, pageCountMatched: true, pageTextMatched: true, pageGeometryMatched: true, pageRendersMatched: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true },
    limitations: [...INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS],
  };
  const deleted = [];
  const copied = [];
  const emitted = [];
  const application = {
    incrementalAccessibilityMetadata: { update: async (_id, request, options) => { assert.deepEqual(request, { language: 'en-us', title: 'Accessible PDF' }); assert.equal(options.sourceSha256, sourceSha256); return result; } },
    store: { getArtifact: () => ({ ...artifact, filePath: '/private/retained.pdf' }), deleteArtifact: async (id) => deleted.push(id) },
  };
  const runtime = {
    cancelled: () => {},
    canonicalOutputTarget: async () => {},
    copyExclusive: async (...args) => copied.push(args),
    emit: async (_stdout, value) => emitted.push(value),
  };
  await runAccessibilityMetadataCommand(application, { language: 'en-us', title: 'Accessible PDF', output: '/tmp/out.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, runtime);
  assert.deepEqual(copied, [['/private/retained.pdf', '/tmp/out.pdf', undefined]]);
  assert.deepEqual(deleted, [artifactId]);
  assert.deepEqual(emitted[0].limitations, INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS);
  assert.equal(emitted[0].sourceBound, true);
  assert.doesNotMatch(JSON.stringify(emitted[0]), /\/private\/|Passive accessibility metadata source|\/Lang|\/Title/u);

  const failureDeleted = [];
  const failingRuntime = { ...runtime, copyExclusive: async () => { throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); } };
  await assert.rejects(
    runAccessibilityMetadataCommand({ ...application, store: { getArtifact: () => ({ ...artifact, filePath: '/private/retained.pdf' }), deleteArtifact: async (id) => failureDeleted.push(id) } }, { language: 'en-us', title: 'Accessible PDF', output: '/tmp/out.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, failingRuntime),
    { code: 'JOB_CANCELLED' },
  );
  assert.deepEqual(failureDeleted, [artifactId]);
});
