import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runAccessibilityMetadataCommand } from '../scripts/cli/commands/accessibility-metadata.mjs';
import {
  INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS,
  INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS,
  INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE,
  INCREMENTAL_ACCESSIBILITY_METADATA_VALIDATORS,
} from '../src/core/pdf-incremental-accessibility-metadata-contract.js';

const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const request = { language: 'en-us', title: 'Accessible PDF' };
const requestSha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');

function validResult(overrides = {}) {
  const artifact = {
    id: artifactId,
    documentId,
    displayName: 'input-language-title-updated.pdf',
    mediaType: 'application/pdf',
    size: 128,
    sha256: outputSha256,
    createdAt: '2026-07-21T00:00:00.000Z',
    operation: {
      schemaVersion: 1,
      id: operationId,
      type: 'pdf-incremental-accessibility-metadata',
      inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
      parameters: { profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, updatedFields: [...INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS], requestSha256 },
      expected: { pageCount: 1, sourceUnchanged: true, sourcePrefixPreserved: true, rasterized: false },
      validation: { passed: true, validators: [...INCREMENTAL_ACCESSIBILITY_METADATA_VALIDATORS], pageCount: 1, outputSha256 },
      completedAt: '2026-07-21T00:00:00.000Z',
    },
  };
  return {
    kind: 'pdf-incremental-accessibility-metadata',
    sourceDigest: sourceSha256,
    artifact,
    metadata: { profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, updatedFields: [...INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS], requestSha256 },
    evidence: {
      sourceDigestReverified: true, sourcePrefixPreserved: true, appendOnlyHistoryRetained: true,
      rawLanguageAndTitleMatched: true, outputUnsigned: true, pageCountMatched: true,
      pageTextMatched: true, pageGeometryMatched: true, pageRendersMatched: true,
      artifactDigestBound: true, sourceUnchanged: true, localOnly: true,
    },
    limitations: [...INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS],
    ...overrides,
  };
}

function fixture({ result = validResult(), update = null, storeArtifact = null } = {}) {
  const calls = [];
  const deleted = [];
  const emitted = [];
  return {
    calls,
    deleted,
    emitted,
    application: {
      incrementalAccessibilityMetadata: {
        update: async (...args) => { calls.push(args); return update ? update(...args) : result; },
      },
      store: {
        getArtifact: () => storeArtifact ?? ({ ...result.artifact, filePath: '/private/accessibility.pdf' }),
        deleteArtifact: async (id) => { deleted.push(id); },
      },
    },
    runtime: {
      cancelled() {},
      canonicalOutputTarget: async () => {},
      copyExclusive: async (...args) => { calls.push(['copy', ...args]); },
      emit: async (_stdout, value) => { emitted.push(value); },
    },
  };
}

test('accessibility metadata parser enforces canonical bounded input', () => {
  assert.deepEqual(parseCliArguments([
    'accessibility-metadata', 'input.pdf', '--language', 'EN-US', '--title', 'Accessible PDF', '--output', 'out.pdf',
  ]), { command: 'accessibility-metadata', input: 'input.pdf', language: 'en-us', title: 'Accessible PDF', output: 'out.pdf' });
  for (const args of [
    ['accessibility-metadata', 'input.pdf', '--language', 'en-us', '--output', 'out.pdf'],
    ['accessibility-metadata', 'input.pdf', '--language', 'en-us', '--title', 'x'],
    ['accessibility-metadata', 'input.pdf', '--language', 'en-us', '--title', '\u0001bad', '--output', 'out.pdf'],
  ]) assert.throws(() => parseCliArguments(args), { code: 'CLI_INVALID_OPTION' });
});

test('accessibility metadata CLI validates result, copies exclusively, deletes artifact, and emits limitations', async () => {
  const state = fixture();
  await runAccessibilityMetadataCommand(state.application, { ...request, output: '/tmp/out.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, state.runtime);
  assert.deepEqual(state.calls[0][1], request);
  assert.equal(state.calls[0][2].sourceSha256, sourceSha256);
  assert.deepEqual(state.calls[1].slice(1, 3), ['/private/accessibility.pdf', '/tmp/out.pdf']);
  assert.deepEqual(state.deleted, [artifactId]);
  assert.equal(state.emitted[0].artifact.output, 'out.pdf');
  assert.deepEqual(state.emitted[0].limitations, INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS);
});

test('accessibility metadata CLI rejects forged result without deleting an untrusted artifact ID', async () => {
  const state = fixture({ result: validResult({ sourceDigest: 'c'.repeat(64) }) });
  await assert.rejects(
    runAccessibilityMetadataCommand(state.application, { ...request, output: '/tmp/out.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, state.runtime),
    { code: 'INVALID_LOCAL_HOST' },
  );
  assert.deepEqual(state.deleted, []);
  assert.equal(state.calls.some((call) => call[0] === 'copy'), false);
});

test('accessibility metadata CLI rejects a mismatched store artifact without authorizing cleanup', async () => {
  const state = fixture({ storeArtifact: { ...validResult().artifact, id: '44444444-4444-4444-8444-444444444444', filePath: '/private/accessibility.pdf' } });
  await assert.rejects(
    runAccessibilityMetadataCommand(state.application, { ...request, output: '/tmp/out.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, state.runtime),
    { code: 'CLI_ARTIFACT_INVALID' },
  );
  assert.deepEqual(state.deleted, []);
  assert.equal(state.calls.some((call) => call[0] === 'copy'), false);
});

test('accessibility metadata CLI binds source digest and cleans on cancellation before copy', async () => {
  const state = fixture();
  state.runtime.cancelled = (() => { let count = 0; return () => { count += 1; if (count === 2) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); }; })();
  await assert.rejects(
    runAccessibilityMetadataCommand(state.application, { ...request, output: '/tmp/out.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, state.runtime),
    { code: 'JOB_CANCELLED' },
  );
  assert.deepEqual(state.deleted, [artifactId]);
  assert.equal(state.calls.some((call) => call[0] === 'copy'), false);

  const mismatch = fixture({ update: async (_id, _request, options) => {
    assert.equal(options.sourceSha256, sourceSha256);
    const error = new Error('source mismatch'); error.code = 'SOURCE_VERSION_MISMATCH'; throw error;
  } });
  await assert.rejects(
    runAccessibilityMetadataCommand(mismatch.application, { ...request, output: '/tmp/out.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, mismatch.runtime),
    { code: 'SOURCE_VERSION_MISMATCH' },
  );
  assert.deepEqual(mismatch.deleted, []);
});

test('accessibility metadata CLI cleans artifact when copy or emit fails', async () => {
  const copyFailure = fixture();
  copyFailure.runtime.copyExclusive = async () => { throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); };
  await assert.rejects(
    runAccessibilityMetadataCommand(copyFailure.application, { ...request, output: '/tmp/out.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, copyFailure.runtime),
    { code: 'JOB_CANCELLED' },
  );
  assert.deepEqual(copyFailure.deleted, [artifactId]);

  const emitFailure = fixture();
  emitFailure.runtime.emit = async () => { throw new Error('emit failed'); };
  await assert.rejects(
    runAccessibilityMetadataCommand(emitFailure.application, { ...request, output: '/tmp/out.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, emitFailure.runtime),
    /emit failed/u,
  );
  assert.deepEqual(emitFailure.deleted, [artifactId]);
});
