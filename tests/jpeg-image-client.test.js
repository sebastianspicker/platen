import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createJpegImageReplacementEndpoints, validateJpegImageReplacementResult } from '../src/core/local-host-jpeg-image-replacement-endpoints.js';

const token = 'a'.repeat(64); const id = '123e4567-e89b-12d3-a456-426614174000';
test('local host client posts fixed JPEG input binding without image bytes', async () => {
  const calls = []; const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 }); return new Response(JSON.stringify({ result: { kind: 'pdf-jpeg-image' } }), { status: 201 }); } });
  await client.bootstrap();
  const request = { profile: 'local-pdf-jpeg-image-v1', sourceSha256: 'b'.repeat(64), inputId: id, inputSha256: 'c'.repeat(64), page: 2, rect: { x: 10, y: 20, width: 100, height: 80 } };
  assert.deepEqual(await client.insertJpegImage(id, request), { kind: 'pdf-jpeg-image' });
  assert.equal(calls[1].path, `/api/documents/${id}/insert-jpeg`); assert.deepEqual(JSON.parse(calls[1].options.body), request); assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.throws(() => client.insertJpegImage('doc', request), TypeError); assert.throws(() => client.insertJpegImage(id, { ...request, jpegBytes: 'no' }), TypeError);
});

function replacementResult() {
  const sourceDigest = 'b'.repeat(64); const outputDigest = 'd'.repeat(64);
  return {
    kind: 'pdf-jpeg-image-replacement', sourceDigest,
    artifact: {
      id, documentId: id, displayName: 'jpeg-image-replacement.pdf', mediaType: 'application/pdf', size: 128,
      sha256: outputDigest,
      operation: {
        schemaVersion: 1, id: '223e4567-e89b-12d3-a456-426614174000', type: 'pdf-jpeg-image-replacement',
        inputs: [{ documentId: id, sha256: sourceDigest, role: 'source' }], parameters: {}, expected: {},
        validation: { passed: true, validators: ['artifact-sha256'], outputSha256: outputDigest }, completedAt: '2026-07-21T00:00:00.000Z',
      },
      createdAt: '2026-07-21T00:00:00.000Z',
    },
    page: 1, resourceName: 'Im0', targetReference: '5 0 R',
    replacementImage: { width: 1, height: 1, components: 3, bytes: 64, sha256: 'c'.repeat(64) },
    invocation: { contentReference: '4 0 R', ctm: [1, 0, 0, 1, 0, 0] },
    evidence: { sourcePrefixPreserved: true, contentPreserved: true, resourceIdentityPreserved: true, objectIdentityPreserved: true, outputDigestBound: true, sourceUnchanged: true, localOnly: true },
    limitations: ['Passive baseline JPEG image XObjects only.'],
  };
}

test('JPEG replacement client validates the exact response envelope and nested result contract', async () => {
  const valid = replacementResult();
  assert.deepEqual(validateJpegImageReplacementResult({ result: valid }), valid);
  assert.throws(() => validateJpegImageReplacementResult({ result: { ...valid, extra: true } }), TypeError);
  assert.throws(() => validateJpegImageReplacementResult({ result: { ...valid, artifact: { ...valid.artifact, size: '128' } } }), TypeError);
  assert.throws(() => validateJpegImageReplacementResult({ result: valid, extra: true }), TypeError);
  const body = {}; Object.defineProperty(body, 'result', { enumerable: true, get() { throw new Error('getter'); } });
  assert.throws(() => validateJpegImageReplacementResult(body), TypeError);
  const endpoint = createJpegImageReplacementEndpoints({ json: async () => ({ result: valid }) });
  assert.deepEqual(await endpoint.replaceJpegImage(id, { profile: 'local-pdf-jpeg-image-replacement-v1', sourceSha256: 'b'.repeat(64), inputId: id, inputSha256: 'c'.repeat(64), page: 1, resourceName: 'Im0' }), valid);
});
