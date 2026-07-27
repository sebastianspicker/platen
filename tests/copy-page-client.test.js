import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  PDF_COPY_PAGE_PROFILE,
  PDF_COPY_PAGE_VALIDATORS as HOST_VALIDATORS,
} from '../scripts/host/pdf-copy-page-contract.mjs';
import {
  PDF_COPY_PAGE_PROFILE as CLIENT_PROFILE,
  PDF_COPY_PAGE_VALIDATORS,
  validatePdfCopyPageArtifact,
} from '../src/core/pdf-copy-page-contract.js';

const primaryDocumentId = '11111111-1111-4111-8111-111111111111';
const secondaryDocumentId = '22222222-2222-4222-8222-222222222222';
const artifactId = '33333333-3333-4333-8333-333333333333';
const operationId = '44444444-4444-4444-8444-444444444444';
const primarySourceSha256 = 'a'.repeat(64);
const secondarySourceSha256 = 'b'.repeat(64);
const artifactSha256 = 'c'.repeat(64);
const manifestSha256 = 'd'.repeat(64);
const token = 'e'.repeat(64);
const timestamp = '2026-07-20T12:00:00.000Z';
const request = Object.freeze({
  primarySourceSha256,
  secondarySourceSha256,
  sourcePage: 4,
  afterPage: 2,
});

test('copy-page browser proof constants exactly match the host', () => {
  assert.equal(CLIENT_PROFILE, PDF_COPY_PAGE_PROFILE);
  assert.deepEqual(PDF_COPY_PAGE_VALIDATORS, HOST_VALIDATORS);
});

function artifact() {
  return {
    id: artifactId,
    documentId: primaryDocumentId,
    displayName: 'primary-page-copied.pdf',
    mediaType: 'application/pdf',
    size: 1_024,
    sha256: artifactSha256,
    operation: {
      schemaVersion: 1,
      id: operationId,
      type: 'copy-page-between-documents',
      inputs: [
        { documentId: primaryDocumentId, sha256: primarySourceSha256, role: 'primary' },
        { documentId: secondaryDocumentId, sha256: secondarySourceSha256, role: 'secondary' },
      ],
      parameters: {
        profile: PDF_COPY_PAGE_PROFILE,
        sourcePage: 4,
        afterPage: 2,
        selections: [
          { input: 0, page: 1 },
          { input: 0, page: 2 },
          { input: 1, page: 4 },
          { input: 0, page: 3 },
        ],
      },
      expected: { pageCount: 4, manifestSha256 },
      validation: {
        passed: true,
        validators: [...PDF_COPY_PAGE_VALIDATORS],
        pageCount: 4,
        manifestSha256,
      },
      completedAt: timestamp,
    },
    createdAt: timestamp,
  };
}

test('copy-page client sends only the fixed two-source request in contract order', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    }
    return new Response(JSON.stringify({ artifact: artifact() }), { status: 201 });
  } });
  await client.bootstrap();
  const result = await client.copyPageBetweenDocuments(
    primaryDocumentId,
    secondaryDocumentId,
    request,
    { signal: controller.signal },
  );
  assert.equal(result.id, artifactId);
  assert.equal(calls[1].path, `/api/documents/${primaryDocumentId}/copy-page`);
  assert.deepEqual(Object.keys(JSON.parse(calls[1].options.body)), [
    'profile', 'primarySourceSha256', 'secondaryDocumentId',
    'secondarySourceSha256', 'sourcePage', 'afterPage',
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: PDF_COPY_PAGE_PROFILE,
    primarySourceSha256,
    secondaryDocumentId,
    secondarySourceSha256,
    sourcePage: 4,
    afterPage: 2,
  });
  assert.equal(calls[1].options.signal, controller.signal);
  assert.throws(
    () => client.copyPageBetweenDocuments(primaryDocumentId, primaryDocumentId, request),
    TypeError,
  );
  assert.throws(
    () => client.copyPageBetweenDocuments(
      primaryDocumentId,
      secondaryDocumentId,
      { ...request, extra: true },
    ),
    TypeError,
  );
});

test('copy-page client rejects provenance drift and private proof leakage', () => {
  const context = { primaryDocumentId, secondaryDocumentId, request };
  assert.equal(validatePdfCopyPageArtifact(artifact(), context).id, artifactId);
  const corruptions = [
    (value) => { value.privateSourcePath = '/private/source.pdf'; },
    (value) => { value.operation.inputs.reverse(); },
    (value) => { value.operation.parameters.selections[2].page = 3; },
    (value) => { value.operation.expected.manifestSha256 = '0'.repeat(64); },
    (value) => { value.operation.validation.validators.pop(); },
    (value) => { value.operation.validation.manifestSha256 = '0'.repeat(64); },
    (value) => { value.operation.parameters.pageTextSha256 = '0'.repeat(64); },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(artifact());
    corrupt(candidate);
    assert.throws(
      () => validatePdfCopyPageArtifact(candidate, context),
      { code: 'INVALID_LOCAL_HOST' },
    );
  }
});

test('copy-page browser proof accepts the host artifact ceiling and rejects larger claims', () => {
  const context = { primaryDocumentId, secondaryDocumentId, request };
  const maximum = artifact();
  maximum.size = 512 * 1024 * 1024;
  assert.equal(validatePdfCopyPageArtifact(maximum, context).size, maximum.size);
  const oversized = structuredClone(maximum);
  oversized.size += 1;
  assert.throws(
    () => validatePdfCopyPageArtifact(oversized, context),
    { code: 'INVALID_LOCAL_HOST' },
  );
});
