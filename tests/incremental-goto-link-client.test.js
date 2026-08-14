import assert from 'node:assert/strict';
import test from 'node:test';
import { PDF_INCREMENTAL_GOTO_LINK_LIMITATIONS } from '../scripts/host/pdf-incremental-goto-link-artifact.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  INCREMENTAL_GOTO_LINK_LIMITATIONS,
  INCREMENTAL_GOTO_LINK_PROFILE,
  INCREMENTAL_GOTO_LINK_VALIDATORS,
  validateIncrementalGoToLinkResult,
} from '../src/core/pdf-incremental-goto-link-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const token = 'c'.repeat(64);
const timestamp = '2026-07-20T12:00:00.000Z';
const request = Object.freeze({
  sourcePage: 1, targetPage: 2,
  rect: Object.freeze({ left: 10, bottom: 20, right: 80, top: 90 }),
});

function result() {
  return {
    kind: 'pdf-incremental-goto-link', sourceDigest: sourceSha256,
    artifact: {
      id: artifactId, documentId, displayName: 'source-goto-link.pdf',
      mediaType: 'application/pdf', size: 1_024, sha256: outputSha256,
      operation: {
        schemaVersion: 1, id: operationId, type: 'pdf-incremental-goto-link',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile: INCREMENTAL_GOTO_LINK_PROFILE, ...structuredClone(request) },
        expected: {
          pageCount: 2, sourceUnchanged: true, sourcePrefixPreserved: true,
          classicIncrementalRevisionAppended: true, rasterized: false,
        },
        validation: {
          passed: true, validators: [...INCREMENTAL_GOTO_LINK_VALIDATORS],
          pageCount: 2, outputSha256,
        },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    link: structuredClone(request),
    evidence: {
      sourceDigestReverified: true, sourcePrefixPreserved: true,
      classicIncrementalRevisionAppended: true, pageCountMatched: true,
      pageTextMatched: true, pageBoxesMatched: true,
      pageValidationRendersMatched: true, outputUnsigned: true,
      artifactDigestBound: true, sourceUnchanged: true, localOnly: true,
    },
    limitations: [...INCREMENTAL_GOTO_LINK_LIMITATIONS],
  };
}

test('incremental GoTo-link client limitations match the host artifact', () => {
  assert.deepEqual(INCREMENTAL_GOTO_LINK_LIMITATIONS, PDF_INCREMENTAL_GOTO_LINK_LIMITATIONS);
});

test('incremental GoTo-link client sends the exact source-bound request', async () => {
  const calls = []; const controller = new AbortController();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: result() }), { status: 201 });
  } });
  await client.bootstrap();
  const value = await client.runIncrementalGoToLink(
    documentId, sourceSha256, request, { signal: controller.signal },
  );
  assert.equal(value.kind, 'pdf-incremental-goto-link');
  assert.equal(calls[1].path, `/api/documents/${documentId}/incremental-goto-link`);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: INCREMENTAL_GOTO_LINK_PROFILE, sourceSha256, ...request,
  });
  assert.throws(() => client.runIncrementalGoToLink(
    documentId, sourceSha256.toUpperCase(), request,
  ), TypeError);
  assert.throws(() => client.runIncrementalGoToLink(
    documentId, sourceSha256, { ...request, targetPage: 0 },
  ), TypeError);
  assert.throws(() => client.runIncrementalGoToLink(
    documentId, sourceSha256, { ...request, rect: { ...request.rect, right: 10 } },
  ), TypeError);
});

test('incremental GoTo-link client rejects crossed provenance and evidence', () => {
  const context = { documentId, sourceSha256, request };
  assert.equal(
    validateIncrementalGoToLinkResult(result(), context).kind,
    'pdf-incremental-goto-link',
  );
  const corruptions = [
    (value) => { value.sourceDigest = '0'.repeat(64); },
    (value) => { value.artifact.documentId = artifactId; },
    (value) => { value.link.rect.right -= 1; },
    (value) => { value.artifact.operation.parameters.targetPage = 1; },
    (value) => {
      value.artifact.operation.expected.pageCount = 1;
      value.artifact.operation.validation.pageCount = 1;
    },
    (value) => { value.artifact.operation.validation.validators.pop(); },
    (value) => { value.artifact.operation.validation.outputSha256 = '0'.repeat(64); },
    (value) => { value.evidence.pageBoxesMatched = false; },
    (value) => { value.limitations[1] = 'General hyperlink support is available.'; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(result()); corrupt(candidate);
    assert.throws(() => validateIncrementalGoToLinkResult(candidate, context), {
      code: 'INVALID_LOCAL_HOST',
    });
  }
});

test('incremental GoTo-link result validation rejects each nested predicate family', () => {
  const context = { documentId, sourceSha256, request };
  const corruptions = [
    (value) => { value.artifact.id = documentId; },
    (value) => { value.artifact.displayName = 'source\u0000goto-link.pdf'; },
    (value) => { value.artifact.mediaType = 'text/plain'; },
    (value) => { value.artifact.size = 63; },
    (value) => { value.artifact.sha256 = sourceSha256; },
    (value) => { value.artifact.createdAt = 'not-a-date'; },
    (value) => { value.artifact.operation.schemaVersion = 2; },
    (value) => { value.artifact.operation.inputs[0].documentId = artifactId; },
    (value) => { value.artifact.operation.parameters.profile = 'forged-profile'; },
    (value) => { value.artifact.operation.parameters.rect.top -= 1; },
    (value) => { value.artifact.operation.expected.rasterized = true; },
    (value) => { value.artifact.operation.validation.validators.reverse(); },
    (value) => { value.kind = 'pdf-incremental-goto-link-forged'; },
    (value) => { value.link.targetPage = 1; },
    (value) => { value.evidence.localOnly = false; },
    (value) => { value.limitations.reverse(); },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(result()); corrupt(candidate);
    assert.throws(() => validateIncrementalGoToLinkResult(candidate, context), {
      code: 'INVALID_LOCAL_HOST',
    });
  }
  for (const corrupt of [
    (value) => { value.artifact = null; },
    (value) => { value.link = null; },
    (value) => { value.evidence = []; },
    (value) => { value.artifact.operation.inputs[0] = null; },
    (value) => { value.artifact.operation.parameters = null; },
    (value) => { value.artifact.operation.expected = null; },
    (value) => { value.artifact.operation.validation = null; },
  ]) {
    const candidate = structuredClone(result()); corrupt(candidate);
    assert.throws(() => validateIncrementalGoToLinkResult(candidate, context), {
      code: 'INVALID_LOCAL_HOST',
    });
  }
});

test('incremental GoTo-link result validation preserves short-circuit getter schedules', () => {
  const context = { documentId, sourceSha256, request };
  const candidate = result();
  let phase = 0;
  let artifactReads = 0;
  let linkReads = 0;
  let evidenceReads = 0;
  const operationReads = [];
  candidate.artifact.operation = new Proxy(candidate.artifact.operation, {
    get(target, property, receiver) {
      operationReads.push(property);
      return Reflect.get(target, property, receiver);
    },
  });
  const scheduled = new Proxy(candidate, {
    get(target, property, receiver) {
      if (property === 'kind') {
        assert.equal(phase, 0); phase = 1;
      } else if (property === 'sourceDigest') {
        assert.equal(phase, 1); phase = 2;
      } else if (property === 'artifact') {
        assert.equal(phase, artifactReads === 0 ? 2 : 6);
        artifactReads += 1;
        phase = artifactReads === 1 ? 3 : phase;
      } else if (property === 'link') {
        assert.equal(phase, linkReads === 0 ? 3 : 4);
        linkReads += 1; phase = 4;
      } else if (property === 'evidence') {
        assert.equal(phase, evidenceReads === 0 ? 4 : 5);
        evidenceReads += 1; phase = 5;
      } else if (property === 'limitations') {
        assert.equal(phase, 5); phase = 6;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal(validateIncrementalGoToLinkResult(scheduled, context), scheduled);
  assert.equal(artifactReads, 3);
  assert.ok(operationReads.indexOf('expected') < operationReads.indexOf('schemaVersion'));

  const rejected = new Proxy(result(), {
    get(target, property, receiver) {
      if (property === 'artifact') throw new Error('must not read after source mismatch');
      return Reflect.get(target, property, receiver);
    },
  });
  rejected.sourceDigest = '0'.repeat(64);
  assert.throws(() => validateIncrementalGoToLinkResult(rejected, context), {
    code: 'INVALID_LOCAL_HOST',
  });
});

test('incremental GoTo-link result validation short-circuits nested artifact and operation reads', () => {
  const context = { documentId, sourceSha256, request };
  const identityRejected = result();
  identityRejected.artifact.id = documentId;
  Object.defineProperty(identityRejected.artifact, 'displayName', {
    enumerable: true,
    get() { throw new Error('display metadata must not be read after an invalid artifact id'); },
  });
  assert.throws(() => validateIncrementalGoToLinkResult(identityRejected, context), {
    code: 'INVALID_LOCAL_HOST',
  });

  const headerRejected = result();
  const reads = [];
  headerRejected.artifact.operation = new Proxy(headerRejected.artifact.operation, {
    get(target, property, receiver) {
      reads.push(property);
      if (property === 'schemaVersion') return 2;
      if (property === 'inputs') throw new Error('inputs must not be read after an invalid header');
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => validateIncrementalGoToLinkResult(headerRejected, context), {
    code: 'INVALID_LOCAL_HOST',
  });
  assert.deepEqual(reads, ['expected', 'schemaVersion']);
});
