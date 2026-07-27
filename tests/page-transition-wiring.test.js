import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { handleIncrementalPageTransitionRoute } from '../scripts/host/routes/incremental-page-transition-routes.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  INCREMENTAL_PAGE_TRANSITION_LIMITATIONS,
  INCREMENTAL_PAGE_TRANSITION_PROFILE,
  INCREMENTAL_PAGE_TRANSITION_VALIDATORS,
  validateIncrementalPageTransitionResult,
} from '../src/core/pdf-incremental-page-transition-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64); const outputSha256 = 'b'.repeat(64); const token = 'c'.repeat(64);
const request = Object.freeze({ pages: Object.freeze([1, 3]), transition: 'Dissolve', duration: 1.5 });
const timestamp = '2026-07-21T12:00:00.000Z';

function result() {
  return {
    kind: 'pdf-incremental-page-transition', sourceDigest: sourceSha256,
    artifact: {
      id: artifactId, documentId, displayName: 'source-page-transition.pdf', mediaType: 'application/pdf', size: 1_024, sha256: outputSha256,
      operation: {
        schemaVersion: 1, id: operationId, type: 'pdf-incremental-page-transition',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile: INCREMENTAL_PAGE_TRANSITION_PROFILE, ...structuredClone(request) },
        expected: { selectedPages: [1, 3], sourceUnchanged: true, sourcePrefixPreserved: true, onlySelectedPagesChanged: true, pageDictionariesPreserved: true, rasterized: false },
        validation: { passed: true, validators: [...INCREMENTAL_PAGE_TRANSITION_VALIDATORS], outputSha256, profile: INCREMENTAL_PAGE_TRANSITION_PROFILE },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    transition: { pages: [1, 3], style: 'Dissolve', duration: 1.5 },
    evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, rawReinspectionPassed: true, pageTopologyPreserved: true, pageContentBoxesResourcesAnnotationsPreserved: true, onlySelectedPagesChanged: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true },
    limitations: [...INCREMENTAL_PAGE_TRANSITION_LIMITATIONS],
  };
}

test('CLI parser accepts only bounded ascending page ranges and millisecond duration', () => {
  assert.deepEqual(parseCliArguments(['page-transition', 'in.pdf', '--pages', '1,3-4', '--duration', '1.5', '--output', 'out.pdf']), { command: 'page-transition', input: 'in.pdf', pages: [1, 3, 4], duration: 1.5, output: 'out.pdf' });
  for (const args of [
    ['page-transition', 'in.pdf', '--pages', '2,1', '--duration', '1', '--output', 'out.pdf'],
    ['page-transition', 'in.pdf', '--pages', '1', '--duration', '0.0001', '--output', 'out.pdf'],
    ['page-transition', 'in.pdf', '--pages', '1', '--duration', '1'],
  ]) assert.throws(() => parseCliArguments(args), { code: /CLI_INVALID/ });
});

test('page-transition client sends exact request and rejects provenance/evidence tampering', async () => {
  const calls = []; const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: result() }), { status: 201 });
  } });
  await client.bootstrap();
  const value = await client.runIncrementalPageTransition(documentId, sourceSha256, request);
  assert.equal(value.kind, 'pdf-incremental-page-transition');
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.artifact.operation.expected), true);
  assert.equal(calls[1].path, `/api/documents/${documentId}/incremental-page-transition`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: INCREMENTAL_PAGE_TRANSITION_PROFILE, sourceSha256, ...request });
  assert.throws(() => client.runIncrementalPageTransition(documentId, sourceSha256, { ...request, pages: [1, 1] }), TypeError);
  const candidate = structuredClone(result()); candidate.artifact.operation.validation.validators.pop();
  assert.throws(() => validateIncrementalPageTransitionResult(candidate, { documentId, sourceSha256, request }), { code: 'INVALID_LOCAL_HOST' });
  for (const corrupt of [
    (value) => { value.artifact.operation.expected.selectedPages = [1]; },
    (value) => { value.artifact.createdAt = '2026-07-21'; },
    (value) => { value.artifact.operation.completedAt = '2026-07-21T12:00:00Z'; },
  ]) {
    const tampered = structuredClone(result()); corrupt(tampered);
    assert.throws(() => validateIncrementalPageTransitionResult(tampered, { documentId, sourceSha256, request }), { code: 'INVALID_LOCAL_HOST' });
  }
});

test('page-transition route enforces POST, no query, exact body, and cancellation cleanup', async () => {
  const response = new EventEmitter(); const deleted = []; const calls = [];
  const context = (body, url = 'http://local.test/api/documents/id/incremental-page-transition') => ({
    request: { method: 'POST' }, response, url: new URL(url), documentId: 'id', operation: 'incremental-page-transition', processing: { signal: new AbortController().signal },
    store: { deleteArtifact: async (id) => deleted.push(id) }, incrementalPageTransition: { update: async (...args) => { calls.push(args); return { artifact: { id: 'artifact' }, kind: 'pdf-incremental-page-transition' }; } }, bodyLimit: 2_048,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)), method: (request, expected) => assert.equal(request.method, expected), readJson: async () => body, json: (_response, status, value) => { response.status = status; response.value = value; },
  });
  const body = { profile: INCREMENTAL_PAGE_TRANSITION_PROFILE, sourceSha256, pages: [1, 3], transition: 'Dissolve', duration: 1.5 };
  assert.equal(await handleIncrementalPageTransitionRoute(context(body)), true); assert.equal(response.status, 201); assert.equal(calls[0][1].transition, 'Dissolve');
  await assert.rejects(handleIncrementalPageTransitionRoute(context({ ...body, extra: true })), { code: 'INVALID_INCREMENTAL_PAGE_TRANSITION_OPTIONS' });
  await assert.rejects(handleIncrementalPageTransitionRoute(context(body, `${new URL('http://local.test/api/documents/id/incremental-page-transition')}?x=1`)), { code: 'INVALID_PARAMETER' });
});
