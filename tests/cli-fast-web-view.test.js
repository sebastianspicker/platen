import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runFastWebViewCommand } from '../scripts/cli/commands/fast-web-view.mjs';

const MAX_VERIFIED_OUTPUT_BYTES = 256 * 1024 * 1024;
const artifactId = '11111111-1111-4111-8111-111111111111';
const document = Object.freeze({ id: '22222222-2222-4222-8222-222222222222', sha256: 'a'.repeat(64) });

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture({ bytes = Buffer.from('%PDF-1.7\nfast-web-view\n'.padEnd(64, ' ')), artifact = {}, writer, cancelled } = {}) {
  const retainedArtifact = Object.freeze({
    id: artifactId,
    filePath: '/private/fast-web-view.pdf',
    size: bytes.length,
    sha256: digest(bytes),
    ...artifact,
  });
  const result = Object.freeze({
    kind: 'pdf-fast-web-view', sourceDigest: document.sha256,
    artifact: Object.freeze({ id: artifactId, size: retainedArtifact.size, sha256: retainedArtifact.sha256 }),
    engine: Object.freeze({ name: 'qpdf', version: 'fixture' }),
  });
  const state = { calls: [], deleted: [], emitted: [] };
  const runtime = {
    cancelled: cancelled ?? (() => {}),
    async canonicalOutputTarget(output) { state.calls.push(['target', output]); },
    async readLocalInputBytes(path, options) {
      state.calls.push(['read', path, options]);
      return Object.freeze({ bytes: Buffer.from(bytes), displayName: 'fast-web-view.pdf' });
    },
    writeExclusiveVerified: writer ?? (async (output, published, signal, finalize) => {
      state.calls.push(['write', output, Buffer.from(published), signal]);
      await finalize(Object.freeze({ size: published.length, sha256: digest(published) }));
    }),
    async emit(_stdout, value) { state.emitted.push(value); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  };
  const application = {
    fastWebView: {
      async linearize(id, request, options) {
        state.calls.push(['linearize', id, request, options]);
        return result;
      },
    },
    store: {
      getArtifact(id) { state.calls.push(['artifact', id]); return retainedArtifact; },
      async deleteArtifact(id) { state.deleted.push(id); },
    },
  };
  return { application, runtime, state, retainedArtifact };
}

test('fast-web-view CLI rereads, verifies, exclusively publishes, and then emits its retained artifact', async () => {
  const value = fixture();
  await runFastWebViewCommand(value.application, { output: '/tmp/linearized.pdf' }, document, null, undefined, value.runtime);
  assert.deepEqual(value.state.calls[0], ['target', '/tmp/linearized.pdf']);
  assert.deepEqual(value.state.calls[1], ['linearize', document.id, { profile: 'local-pdf-fast-web-view-v1' }, { sourceSha256: document.sha256, signal: undefined }]);
  assert.deepEqual(value.state.calls[3], ['read', value.retainedArtifact.filePath, {
    minimumBytes: 64, maximumBytes: MAX_VERIFIED_OUTPUT_BYTES, extension: '.pdf', signal: undefined,
  }]);
  assert.equal(value.state.calls[4][0], 'write');
  assert.equal(value.state.calls[4][2].equals(Buffer.from('%PDF-1.7\nfast-web-view\n'.padEnd(64, ' '))), true);
  assert.equal(value.state.emitted.length, 1);
  assert.equal(value.state.emitted[0].artifact.output, 'linearized.pdf');
  assert.deepEqual(value.state.deleted, [artifactId]);
});

test('fast-web-view CLI rejects retained artifact size and digest drift without publication or emission', async () => {
  const sizeDrift = fixture({ artifact: { size: 65 } });
  await assert.rejects(
    runFastWebViewCommand(sizeDrift.application, { output: '/tmp/linearized.pdf' }, document, null, undefined, sizeDrift.runtime),
    { code: 'CLI_FAST_WEB_VIEW_ARTIFACT_MISMATCH' },
  );
  assert.equal(sizeDrift.state.calls.some(([kind]) => kind === 'write'), false);
  assert.deepEqual(sizeDrift.state.emitted, []);
  assert.deepEqual(sizeDrift.state.deleted, [artifactId]);

  const digestDrift = fixture({ artifact: { sha256: 'b'.repeat(64) } });
  await assert.rejects(
    runFastWebViewCommand(digestDrift.application, { output: '/tmp/linearized.pdf' }, document, null, undefined, digestDrift.runtime),
    { code: 'CLI_FAST_WEB_VIEW_ARTIFACT_MISMATCH' },
  );
  assert.equal(digestDrift.state.calls.some(([kind]) => kind === 'write'), false);
  assert.deepEqual(digestDrift.state.emitted, []);
  assert.deepEqual(digestDrift.state.deleted, [artifactId]);
});

test('fast-web-view CLI rejects an oversized artifact before reading it', async () => {
  const value = fixture({ artifact: { size: MAX_VERIFIED_OUTPUT_BYTES + 1 } });
  await assert.rejects(
    runFastWebViewCommand(value.application, { output: '/tmp/linearized.pdf' }, document, null, undefined, value.runtime),
    {
      code: 'CLI_FAST_WEB_VIEW_ARTIFACT_TOO_LARGE',
      message: 'The fast web-view artifact exceeds the 256 MiB verified publication limit.',
    },
  );
  assert.equal(value.state.calls.some(([kind]) => kind === 'read'), false);
  assert.equal(value.state.calls.some(([kind]) => kind === 'write'), false);
  assert.deepEqual(value.state.emitted, []);
  assert.deepEqual(value.state.deleted, [artifactId]);
});

test('fast-web-view CLI rejects a verified-writer receipt mismatch without emitting and removes the artifact', async () => {
  const value = fixture({ writer: async (_output, _bytes, _signal, finalize) => {
    await finalize(Object.freeze({ size: 1, sha256: '0'.repeat(64) }));
  } });
  await assert.rejects(
    runFastWebViewCommand(value.application, { output: '/tmp/linearized.pdf' }, document, null, undefined, value.runtime),
    { code: 'CLI_FAST_WEB_VIEW_RECEIPT_MISMATCH' },
  );
  assert.deepEqual(value.state.emitted, []);
  assert.deepEqual(value.state.deleted, [artifactId]);
});

test('fast-web-view CLI cancellation in the publication finalizer emits nothing and still removes the artifact', async () => {
  let checks = 0;
  const value = fixture({ cancelled: () => {
    checks += 1;
    if (checks === 4) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
  } });
  await assert.rejects(
    runFastWebViewCommand(value.application, { output: '/tmp/linearized.pdf' }, document, null, undefined, value.runtime),
    { code: 'JOB_CANCELLED' },
  );
  assert.deepEqual(value.state.emitted, []);
  assert.deepEqual(value.state.deleted, [artifactId]);
});
