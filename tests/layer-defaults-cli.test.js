import assert from 'node:assert/strict';
import test from 'node:test';
import { runLayerDefaultsCommand } from '../scripts/cli/commands/layer-defaults.mjs';
import { PDF_LAYER_DEFAULTS_PROFILE } from '../scripts/host/pdf-layer-defaults-contract.mjs';
import { PDF_LAYER_DEFAULTS_LIMITATIONS } from '../scripts/host/pdf-layer-defaults-service.mjs';

const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';

function artifact({ sha256 = outputSha256 } = {}) {
  return {
    id: artifactId,
    documentId,
    displayName: 'source-layer-defaults.pdf',
    mediaType: 'application/pdf',
    size: 180,
    sha256,
    operation: {
      schemaVersion: 1,
      id: operationId,
      type: 'pdf-layer-defaults',
      inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
      parameters: { groupCount: 2, visibleGroupIndices: [0], hiddenGroupIndices: [1] },
      expected: { groupCount: 2, sourceUnchanged: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, rasterized: false },
      validation: { passed: true, validators: ['source-sha256'], groupCount: 2, visibleGroupIndices: [0], outputSha256 },
      completedAt: '2026-08-03T00:00:00.000Z',
    },
    createdAt: '2026-08-03T00:00:00.000Z',
  };
}

function result({ extra = {}, artifactValue = artifact() } = {}) {
  return {
    kind: 'pdf-layer-defaults',
    sourceDigest: sourceSha256,
    artifact: artifactValue,
    proof: {
      profile: PDF_LAYER_DEFAULTS_PROFILE,
      sourceBytes: 160,
      outputBytes: 180,
      appendedBytes: 20,
      sourcePrefixPreserved: true,
      onlyCatalogChanged: true,
      revisionCount: 2,
      groupCount: 2,
      visible: [true, false],
      catalogReference: '1 0 R',
      outputSha256,
    },
    evidence: {
      sourceDigestReverified: true,
      sourcePrefixPreserved: true,
      onlyCatalogChanged: true,
      classicIncrementalRevisionAppended: true,
      outputUnsigned: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: [...PDF_LAYER_DEFAULTS_LIMITATIONS],
    ...extra,
  };
}

function runtime({ cancelled = () => {}, copyExclusive = async () => {}, emit = async () => {} } = {}) {
  return {
    cancelled,
    canonicalOutputTarget: async () => {},
    copyExclusive,
    emit,
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  };
}

function application(serviceResult, { stored = artifact(), deleted = [], calls = [] } = {}) {
  return {
    layerDefaults: {
      async update(...args) { calls.push(args); return serviceResult; },
    },
    store: {
      getArtifact(id) { assert.equal(id, stored.id); return { ...stored, filePath: '/private/jobs/layer-defaults/output.pdf' }; },
      async deleteArtifact(id) { deleted.push(id); },
    },
  };
}

test('layer-defaults CLI validates the trusted artifact, copies with the signal, and emits a frozen privacy-safe receipt', async () => {
  const calls = []; const deleted = []; const copied = []; const emitted = [];
  const app = application(result(), { deleted, calls });
  const controller = new AbortController();
  await runLayerDefaultsCommand(app, { changes: [{ groupIndex: 1, visible: false }], output: '/tmp/layers.pdf' }, { id: documentId, sha256: sourceSha256 }, null, controller.signal,
    runtime({
      copyExclusive: async (...args) => copied.push(args),
      emit: async (_stdout, value) => emitted.push(value),
    }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], documentId);
  assert.deepEqual(calls[0][1], { profile: PDF_LAYER_DEFAULTS_PROFILE, sourceSha256, changes: [{ groupIndex: 1, visible: false }] });
  assert.equal(calls[0][2].sourceSha256, sourceSha256);
  assert.equal(calls[0][2].signal, controller.signal);
  assert.deepEqual(deleted, [artifactId]);
  assert.equal(copied.length, 1);
  assert.equal(copied[0][2], controller.signal);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].artifact.output, 'layers.pdf');
  assert.equal(Object.hasOwn(emitted[0], 'sourceDigest'), false);
  assert.equal(Object.hasOwn(emitted[0].artifact, 'filePath'), false);
  assert.equal(Object.hasOwn(emitted[0].artifact, 'operation'), false);
  assert.equal(Object.isFrozen(emitted[0]), true);
  assert.equal(Object.isFrozen(emitted[0].artifact), true);
  assert.equal(Object.isFrozen(emitted[0].proof), true);
});

test('layer-defaults CLI fails closed for forged service results without deleting an untrusted artifact', async () => {
  const deleted = []; let copied = 0;
  const app = application(result({ extra: { forged: true } }), { deleted });
  await assert.rejects(
    runLayerDefaultsCommand(app, { changes: [], output: '/tmp/layers.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined,
      runtime({ copyExclusive: async () => { copied += 1; } })),
    { code: 'CLI_LAYER_DEFAULTS_RESULT_INVALID' },
  );
  assert.equal(copied, 0);
  assert.deepEqual(deleted, []);

  const mismatchDeleted = [];
  const mismatch = application(result(), { stored: artifact({ sha256: 'c'.repeat(64) }), deleted: mismatchDeleted });
  await assert.rejects(
    runLayerDefaultsCommand(mismatch, { changes: [], output: '/tmp/layers.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined, runtime()),
    { code: 'CLI_LAYER_DEFAULTS_ARTIFACT_INVALID' },
  );
  assert.deepEqual(mismatchDeleted, []);
});

test('layer-defaults CLI revokes only the trusted artifact when cancellation arrives after promotion', async () => {
  const deleted = []; let checks = 0; let copied = 0; let emitted = 0;
  const app = application(result(), { deleted });
  const cancellation = Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
  await assert.rejects(
    runLayerDefaultsCommand(app, { changes: [], output: '/tmp/layers.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined,
      runtime({
        cancelled: () => { checks += 1; if (checks > 1) throw cancellation; },
        copyExclusive: async () => { copied += 1; },
        emit: async () => { emitted += 1; },
      })),
    { code: 'JOB_CANCELLED' },
  );
  assert.equal(copied, 0);
  assert.equal(emitted, 0);
  assert.deepEqual(deleted, [artifactId]);
});

test('layer-defaults CLI revokes the trusted artifact when exclusive publication fails', async () => {
  const deleted = [];
  const app = application(result(), { deleted });
  await assert.rejects(
    runLayerDefaultsCommand(app, { changes: [], output: '/tmp/layers.pdf' }, { id: documentId, sha256: sourceSha256 }, null, undefined,
      runtime({ copyExclusive: async () => { throw new Error('exclusive copy failed'); } })),
    /exclusive copy failed/u,
  );
  assert.deepEqual(deleted, [artifactId]);
});
