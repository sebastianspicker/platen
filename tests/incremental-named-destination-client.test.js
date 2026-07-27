import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PDF_INCREMENTAL_NAMED_DESTINATION_LIMITATIONS as HOST_LIMITATIONS,
} from '../scripts/host/pdf-incremental-named-destination-artifact.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  INCREMENTAL_NAMED_DESTINATION_LIMITATIONS,
  INCREMENTAL_NAMED_DESTINATION_PROFILE,
  INCREMENTAL_NAMED_DESTINATION_VALIDATORS,
  validateIncrementalNamedDestinationResult,
} from '../src/core/pdf-incremental-named-destination-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const token = 'c'.repeat(64);
const timestamp = '2026-07-20T12:00:00.000Z';
const request = Object.freeze({ targetPage: 2, name: 'chapter-one' });
const nameSha256 = createHash('sha256').update(request.name, 'ascii').digest('hex');

function result() {
  return {
    kind: 'pdf-incremental-named-destination', sourceDigest: sourceSha256,
    artifact: {
      id: artifactId, documentId, displayName: 'source-named-destination.pdf',
      mediaType: 'application/pdf', size: 1_024, sha256: outputSha256,
      operation: {
        schemaVersion: 1, id: operationId,
        type: 'pdf-incremental-named-destination',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: {
          profile: INCREMENTAL_NAMED_DESTINATION_PROFILE,
          targetPage: request.targetPage, nameSha256,
        },
        expected: {
          pageCount: 2, namedDestinationAdded: true, sourceUnchanged: true,
          sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true,
          rasterized: false,
        },
        validation: {
          passed: true, validators: [...INCREMENTAL_NAMED_DESTINATION_VALIDATORS],
          pageCount: 2, outputSha256,
        },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    destination: {
      profile: INCREMENTAL_NAMED_DESTINATION_PROFILE,
      targetPage: request.targetPage, nameSha256, fit: true,
    },
    evidence: {
      sourceDigestReverified: true, sourcePrefixPreserved: true,
      classicIncrementalRevisionAppended: true,
      namedDestinationAbsentBefore: true, namedDestinationMatched: true,
      pageCountMatched: true, pageTextMatched: true, pageBoxesMatched: true,
      pageValidationRendersMatched: true, outputUnsigned: true,
      artifactDigestBound: true, sourceUnchanged: true, localOnly: true,
    },
    limitations: [...INCREMENTAL_NAMED_DESTINATION_LIMITATIONS],
  };
}

test('named-destination client sends the exact transient name and validates its digest', async () => {
  assert.deepEqual(INCREMENTAL_NAMED_DESTINATION_LIMITATIONS, HOST_LIMITATIONS);
  const calls = [];
  const controller = new AbortController();
  const client = new LocalHostClient({
    fetchImpl: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: result() }), { status: 201 });
    },
  });
  await client.bootstrap();
  const value = await client.runIncrementalNamedDestination(
    documentId, sourceSha256, request, { signal: controller.signal },
  );
  assert.equal(value.destination.nameSha256, nameSha256);
  assert.equal(calls[1].path, `/api/documents/${documentId}/incremental-named-destination`);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: INCREMENTAL_NAMED_DESTINATION_PROFILE,
    sourceSha256, targetPage: request.targetPage, name: request.name,
  });
  assert.equal(calls[1].options.signal, controller.signal);
  assert.throws(
    () => client.runIncrementalNamedDestination(documentId, sourceSha256, {
      ...request, name: '!unsafe',
    }),
    TypeError,
  );
});

test('named-destination client snapshots a mutable request before asynchronous hashing', async () => {
  let posted;
  const client = new LocalHostClient({
    fetchImpl: async (path, options = {}) => {
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
      }
      posted = JSON.parse(options.body);
      return new Response(JSON.stringify({ result: result() }), { status: 201 });
    },
  });
  await client.bootstrap();
  const mutable = { ...request };
  const pending = client.runIncrementalNamedDestination(
    documentId, sourceSha256, mutable,
  );
  mutable.targetPage = 1;
  mutable.name = 'mutated-after-call';
  const value = await pending;
  assert.equal(value.destination.nameSha256, nameSha256);
  assert.deepEqual(posted, {
    profile: INCREMENTAL_NAMED_DESTINATION_PROFILE,
    sourceSha256, targetPage: request.targetPage, name: request.name,
  });
});

test('named-destination client rejects crossed or exaggerated host evidence', () => {
  const context = { documentId, sourceSha256, request, nameSha256 };
  assert.equal(
    validateIncrementalNamedDestinationResult(result(), context).kind,
    'pdf-incremental-named-destination',
  );
  const corruptions = [
    (value) => { value.sourceDigest = '0'.repeat(64); },
    (value) => { value.destination.nameSha256 = '0'.repeat(64); },
    (value) => { value.destination.fit = false; },
    (value) => { value.artifact.operation.parameters.targetPage = 1; },
    (value) => { value.artifact.operation.expected.namedDestinationAdded = false; },
    (value) => { value.evidence.namedDestinationMatched = false; },
    (value) => { value.limitations[1] = 'General destination management.'; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(result());
    corrupt(candidate);
    assert.throws(
      () => validateIncrementalNamedDestinationResult(candidate, context),
      { code: 'INVALID_LOCAL_HOST' },
    );
  }
});
