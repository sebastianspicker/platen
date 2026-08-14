import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaggedRemediationEndpoints } from '../src/core/local-host-tagged-remediation-endpoints.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceSha256 = 'a'.repeat(64);
const artifactSha256 = 'b'.repeat(64);
const profile = 'local-tagged-pdf-remediation-v1';

function request(overrides = {}) {
  return {
    profile, sourceSha256,
    plan: { id: 'document', role: 'Document', children: [{ id: 'paragraph', role: 'P', page: 1, contentIndex: 0 }] },
    language: 'en-US', title: 'Fixture', roleMap: {}, ...overrides,
  };
}

function result(overrides = {}) {
  return {
    kind: 'tagged-pdf-remediation', profile, sourceDigest: sourceSha256,
    artifact: {
      id: '22222222-2222-4222-8222-222222222222', documentId,
      displayName: 'tagged-pdf-remediation.pdf', mediaType: 'application/pdf', size: 256,
      sha256: artifactSha256, operation: { inputs: [{ documentId, sha256: sourceSha256 }] }, createdAt: '2026-08-03T00:00:00.000Z',
    },
    proof: {
      profile, sourceSha256, outputSha256: artifactSha256, sourcePrefixPreserved: true,
      originalContentStreamsUnchanged: true, deterministic: true, pageCount: 1,
      pageGeometry: [{ mediaBox: [0, 0, 612, 792], cropBox: [0, 0, 612, 792], rotate: 0 }],
      structureLinked: true, structTreeRootObjectNumber: 9, appendedBytes: 512, revisionCount: 2,
      originalContentStreams: [{ page: 1, contentIndex: 0, sha256: 'c'.repeat(64), bytes: 4 }],
    },
    evidence: { sourceBound: true, sourceUnchanged: true, outputDigestBound: true, independentInspection: true },
    limitations: [
      'This bounded local writer either edits a complete source-bound tag tree or adds a legacy candidate tree to a narrow passive PDF subset.',
      'It does not claim PDF/UA conformance, semantic reading-order correctness, or whole-document accessibility remediation.',
      'Existing-structure mode rejects prior revisions and unsupported links, tables, forms, annotations, active content, signatures, encryption, layers, and ambiguous content.',
    ],
    ...overrides,
  };
}

function transport(response = result()) {
  const calls = [];
  const endpoints = createTaggedRemediationEndpoints({
    json: async (path, options) => { calls.push({ path, options }); return { result: response }; },
  });
  return { endpoints, calls };
}

test('tagged remediation client snapshots the canonical request and validates/freeze the public result', async () => {
  const state = transport();
  const value = await state.endpoints.updateTaggedRemediation(documentId, request());
  assert.equal(state.calls.length, 1);
  assert.equal(JSON.parse(state.calls[0].options.body).profile, profile);
  assert.equal(value.sourceDigest, sourceSha256);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.artifact), true);
  assert.equal(Object.isFrozen(value.proof.pageGeometry[0]), true);
  assert.throws(() => { value.evidence.sourceBound = false; }, TypeError);
});

test('tagged remediation client rejects malformed graphs before network and rejects unsafe results', async () => {
  const state = transport();
  const cases = [
    request({ plan: { id: 'document', role: 'Document', children: [{ id: 'p', role: 'P', page: 1, contentIndex: 2_000 }] } }),
    request({ plan: { id: 'document', role: 'Document', children: [{ id: 'p', role: 'Custom', page: 1, contentIndex: 0 }] } }),
    request({ plan: { id: 'document', role: 'Document', children: [{ id: 'p', role: 'P', page: 1, contentIndex: 0, extra: true }] } }),
    request({ roleMap: { Custom: 'P' }, plan: { id: 'document', role: 'Document', children: [{ id: 'p', role: 'Custom', page: 1, contentIndex: 0 }] } }),
  ];
  for (const value of cases) assert.throws(() => state.endpoints.updateTaggedRemediation(documentId, value), TypeError);
  const accessor = request(); Object.defineProperty(accessor, 'sourceSha256', { get() { throw new Error('must not read'); } });
  assert.throws(() => state.endpoints.updateTaggedRemediation(documentId, accessor), TypeError);
  const proxied = new Proxy(request(), { ownKeys() { throw new Error('must not enumerate'); } });
  assert.throws(() => state.endpoints.updateTaggedRemediation(documentId, proxied), TypeError);
  assert.equal(state.calls.length, 0);

  for (const unsafe of [
    { artifact: { filePath: '/private/output.pdf' } },
    { sourceDigest: 'f'.repeat(64) },
    { evidence: { sourceBound: true, sourceUnchanged: true, outputDigestBound: true, independentInspection: false } },
    { limitations: ['PDF/UA conformance proven'] },
  ]) {
    const response = result(unsafe);
    await assert.rejects(transport(response).endpoints.updateTaggedRemediation(documentId, request()), TypeError);
  }
});

test('tagged remediation client validates existing-structure references and AbortSignal options', async () => {
  const existingPlan = {
    id: 'document', role: 'Document', mode: 'existing-structure-v1',
    structRef: { object: 9, generation: 0 },
    children: [{ id: 'paragraph', role: 'P', structRef: { object: 10, generation: 0 }, page: 1, contentIndex: 0, contentRef: { object: 11, generation: 0 }, mcid: 0 }],
  };
  const state = transport({ ...result(), proof: { ...result().proof, tagTreeReinspected: true, textEvidence: 'content-streams-unchanged', renderingEvidence: 'page-geometry-and-content-preserved' } });
  await state.endpoints.updateTaggedRemediation(documentId, request({ plan: existingPlan, language: null, title: null }), { signal: new AbortController().signal });
  assert.equal(state.calls.length, 1);
  assert.throws(() => state.endpoints.updateTaggedRemediation(documentId, request(), { signal: {} }), TypeError);
  assert.throws(() => state.endpoints.updateTaggedRemediation(documentId, request({ plan: existingPlan, language: 'en-US', title: null })), TypeError);
});
