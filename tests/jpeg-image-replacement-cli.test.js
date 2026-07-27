import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runJpegImageReplacementCommand } from '../scripts/cli/commands/jpeg-image-replacement.mjs';
import { PDF_JPEG_IMAGE_REPLACEMENT_PROFILE } from '../scripts/host/pdf-jpeg-image-replacement-writer.mjs';

test('replace-jpeg CLI binds private input, resource identity, source digest, and trusted artifact output', async () => {
  const events = []; const bytes = Buffer.from('abcdefghijkl'); const input = { id: '123e4567-e89b-12d3-a456-426614174000', mediaType: 'image/jpeg', extension: '.jpg', size: 12, sha256: createHash('sha256').update(bytes).digest('hex') }; const artifact = { id: '223e4567-e89b-12d3-a456-426614174000', documentId: 'doc', mediaType: 'application/pdf', size: 128, sha256: 'd'.repeat(64), filePath: '/private/replacement.pdf' };
  const application = { inputs: { createInput: async ({ mediaType }) => { events.push(['create', mediaType]); return input; }, verifyInput: async (id) => events.push(['verify', id]), deleteInput: async (id) => events.push(['delete', id]) }, jpegImageReplacement: { replace: async (_id, request) => { events.push(['replace', request.profile, request.page, request.resourceName, request.inputId, request.inputSha256]); return { kind: 'pdf-jpeg-image-replacement', artifact }; } }, store: { getArtifact: () => artifact, deleteArtifact: async (id) => events.push(['artifact-delete', id]) } };
  await runJpegImageReplacementCommand(application, { image: 'replacement.jpg', page: 2, resourceName: 'Im0', output: '/tmp/replaced.pdf' }, { id: 'doc', sha256: 'b'.repeat(64) }, null, undefined, { cancelled() {}, canonicalOutputTarget: async () => {}, readLocalInputBytes: async () => ({ bytes, displayName: 'replacement.jpg' }), copyExclusive: async (...args) => events.push(['copy', ...args]), emit: async () => {}, fail(code) { throw Object.assign(new Error(code), { code }); } });
  assert.deepEqual(events, [['create', 'image/jpeg'], ['verify', input.id], ['replace', PDF_JPEG_IMAGE_REPLACEMENT_PROFILE, 2, 'Im0', input.id, input.sha256], ['copy', '/private/replacement.pdf', '/tmp/replaced.pdf'], ['artifact-delete', artifact.id], ['delete', input.id]]);
});

function cliFixture({ input = null, result = null, stored = null, cancelled = () => {}, emit = async () => {}, copyExclusive = async () => {} } = {}) {
  const bytes = Buffer.from('abcdefghijkl');
  const selected = { bytes, displayName: 'replacement.jpg' };
  const record = input ?? { id: '123e4567-e89b-12d3-a456-426614174000', mediaType: 'image/jpeg', extension: '.jpg', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const artifactId = '223e4567-e89b-12d3-a456-426614174000';
  const artifact = stored ?? { id: artifactId, documentId: 'doc', mediaType: 'application/pdf', size: 128, sha256: 'd'.repeat(64), filePath: '/private/replacement.pdf' };
  const output = result ?? { kind: 'pdf-jpeg-image-replacement', artifact: { id: artifact.id, sha256: artifact.sha256, size: artifact.size } };
  const events = [];
  return {
    application: {
      inputs: { createInput: async () => record, verifyInput: async () => {}, deleteInput: async (id) => events.push(['asset-delete', id]) },
      jpegImageReplacement: { replace: async () => output },
      store: { getArtifact: () => artifact, deleteArtifact: async (id) => events.push(['artifact-delete', id]) },
    },
    command: { image: 'replacement.jpg', page: 1, resourceName: 'Im0', output: '/tmp/replaced.pdf' },
    document: { id: 'doc', sha256: 'b'.repeat(64) },
    runtime: { cancelled, canonicalOutputTarget: async () => {}, readLocalInputBytes: async () => selected, copyExclusive: async (...args) => { events.push(['copy', ...args]); return copyExclusive(...args); }, emit, fail(code, message) { throw Object.assign(new Error(message), { code }); } },
    events,
  };
}

test('replace-jpeg CLI does not delete forged input or result identifiers', async () => {
  const forgedAsset = cliFixture({ input: { id: 'forged', mediaType: 'image/jpeg', extension: '.jpg', size: 12, sha256: createHash('sha256').update(Buffer.from('abcdefghijkl')).digest('hex') } });
  await assert.rejects(runJpegImageReplacementCommand(forgedAsset.application, forgedAsset.command, forgedAsset.document, null, undefined, forgedAsset.runtime), { code: 'CLI_INVALID_INPUT_RECORD' });
  assert.deepEqual(forgedAsset.events, []);
  const forgedResult = cliFixture({ result: { kind: 'pdf-jpeg-image-replacement', artifact: { id: 'forged', sha256: 'f'.repeat(64), size: 128 } } });
  await assert.rejects(runJpegImageReplacementCommand(forgedResult.application, forgedResult.command, forgedResult.document, null, undefined, forgedResult.runtime), { code: 'CLI_INVALID_RESULT' });
  assert.deepEqual(forgedResult.events, [['asset-delete', '123e4567-e89b-12d3-a456-426614174000']]);
});

test('replace-jpeg CLI revokes trusted artifact when cancellation precedes exclusive-copy commit', async () => {
  let calls = 0;
  const fixture = cliFixture({ cancelled() { calls += 1; if (calls === 3) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); } });
  await assert.rejects(runJpegImageReplacementCommand(fixture.application, fixture.command, fixture.document, null, undefined, fixture.runtime), { code: 'JOB_CANCELLED' });
  assert.deepEqual(fixture.events, [['artifact-delete', fixture.application.store.getArtifact().id], ['asset-delete', '123e4567-e89b-12d3-a456-426614174000']]);
});

test('replace-jpeg CLI cleans trusted artifact after emit failure and treats copy as commit point', async () => {
  const emitted = cliFixture({ emit: async () => { throw new Error('emit failed'); } });
  await assert.rejects(runJpegImageReplacementCommand(emitted.application, emitted.command, emitted.document, null, undefined, emitted.runtime), /emit failed/u);
  assert.deepEqual(emitted.events, [['copy', '/private/replacement.pdf', '/tmp/replaced.pdf'], ['artifact-delete', emitted.application.store.getArtifact().id], ['asset-delete', '123e4567-e89b-12d3-a456-426614174000']]);
  const failedCopy = cliFixture({ copyExclusive: async () => { throw new Error('copy failed'); } });
  await assert.rejects(runJpegImageReplacementCommand(failedCopy.application, failedCopy.command, failedCopy.document, null, undefined, failedCopy.runtime), /copy failed/u);
  assert.deepEqual(failedCopy.events, [['copy', '/private/replacement.pdf', '/tmp/replaced.pdf'], ['artifact-delete', failedCopy.application.store.getArtifact().id], ['asset-delete', '123e4567-e89b-12d3-a456-426614174000']]);
});
