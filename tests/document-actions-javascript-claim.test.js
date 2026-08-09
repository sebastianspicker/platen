import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { deliverProfessionalCapability } from '../scripts/host/professional-capability/index.mjs';
import {
  PDF_JAVASCRIPT_REMOVAL_LIMITATIONS,
  PDF_JAVASCRIPT_REMOVAL_PROFILE,
  PDF_JAVASCRIPT_REMOVAL_VALIDATORS,
} from '../src/core/pdf-javascript-removal-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputBytes = Buffer.from(`%PDF-1.7\n${'javascript removed '.repeat(64)}\n%%EOF\n`);
const outputSha256 = createHash('sha256').update(outputBytes).digest('hex');

function javascriptPdf() {
  const values = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources <<>> >>',
    '<< /S /JavaScript /JS (app.alert\\(\"fixture\"\\)) >>',
  ];
  const chunks = ['%PDF-1.7\n'];
  const offsets = [];
  values.forEach((value, index) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${index + 1} 0 obj\n${value}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 5\n0000000000 65535 f \n');
  offsets.forEach((offset) => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}
const timestamp = '2026-08-05T12:00:00.000Z';

function receipt() {
  return {
    kind: 'pdf-javascript-removal',
    sourceDigest: sourceSha256,
    artifact: {
      id: artifactId,
      documentId,
      displayName: 'source-javascript-removed.pdf',
      mediaType: 'application/pdf',
      size: outputBytes.length,
      sha256: outputSha256,
      operation: {
        schemaVersion: 1,
        id: operationId,
        type: 'pdf-javascript-removal',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile: PDF_JAVASCRIPT_REMOVAL_PROFILE },
        expected: {
          pageCount: 2,
          sourceUnchanged: true,
          closedClassicRevision: true,
          priorRevisionsAbsent: true,
          rasterized: false,
        },
        validation: {
          passed: true,
          validators: [...PDF_JAVASCRIPT_REMOVAL_VALIDATORS],
          pageCount: 2,
          outputSha256,
        },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    removal: { profile: PDF_JAVASCRIPT_REMOVAL_PROFILE, removedLocus: 'open-action' },
    evidence: {
      sourceDigestReverified: true,
      closedClassicRevision: true,
      priorRevisionsAbsent: true,
      javascriptSurfacesAbsent: true,
      removedReferencesUnresolvable: true,
      pageCountMatched: true,
      pageTextMatched: true,
      pageBoxesMatched: true,
      pageValidationRendersMatched: true,
      outputUnsigned: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: [...PDF_JAVASCRIPT_REMOVAL_LIMITATIONS],
  };
}

function context(overrides = {}) {
  return {
    documentId,
    sourceSha256,
    profile: PDF_JAVASCRIPT_REMOVAL_PROFILE,
    readArtifact: async () => Buffer.from(outputBytes),
    ...overrides,
  };
}

test('document.actions-javascript delegates one fixed source-bound removal and returns only the retained receipt boundary', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const javascriptRemoval = {
    async remove(...args) {
      calls.push(args);
      return receipt();
    },
  };
  const outcome = await deliverProfessionalCapability('document.actions-javascript', context({ javascriptRemoval, signal }));
  assert.deepEqual(calls, [[
    documentId,
    { profile: PDF_JAVASCRIPT_REMOVAL_PROFILE },
    { sourceSha256, signal },
  ]]);
  assert.equal(outcome.method, 'production-pdf-javascript-removal-service');
  assert.equal(outcome.artifact.id, artifactId);
  assert.equal(outcome.outputSha256, outputSha256);
  assert.equal(outcome.removal.removedLocus, 'open-action');
  assert.equal(outcome.allowExecution, false);
  assert.equal(outcome.allowAuthoring, false);
  assert.equal(outcome.retainedBoundaryValidated, true);
  assert.equal(outcome.serviceReceipt.kind, 'pdf-javascript-removal');
  assert.doesNotMatch(JSON.stringify(outcome), /app\.alert|input\.pdf|workspacePath|filePath|%PDF/u);
});

test('composed local application routes document.actions-javascript through the configured retained removal service', { timeout: 30_000 }, async (t) => {
  const application = await createLocalApplication({ root: process.cwd(), token: 'j'.repeat(64) });
  t.after(() => application.close());
  const document = await application.store.createDocument({
    stream: Readable.from([javascriptPdf()]),
    displayName: 'document-javascript.pdf',
    mediaType: 'application/pdf',
  });
  const outcome = await application.professionalCapabilities.deliver('document.actions-javascript', {
    documentId: document.id,
    profile: PDF_JAVASCRIPT_REMOVAL_PROFILE,
  });
  const retained = application.store.getArtifact(outcome.artifact.id);
  assert.equal(outcome.method, 'production-pdf-javascript-removal-service');
  assert.equal(outcome.sourceSha256, document.sha256);
  assert.equal(outcome.artifact.documentId, document.id);
  assert.equal(retained.sha256, outcome.outputSha256);
  assert.equal(outcome.evidence.javascriptSurfacesAbsent, true);
  assert.equal(outcome.allowExecution, false);
  assert.equal(outcome.allowAuthoring, false);
  await application.store.deleteArtifact(outcome.artifact.id);
});

test('document.actions-javascript fails closed for unavailable authority and malformed identity, digest, profile, and signal inputs', async () => {
  await assert.rejects(
    deliverProfessionalCapability('document.actions-javascript', context()),
    { code: 'DOCUMENT_ACTIONS_JAVASCRIPT_UNAVAILABLE', status: 503 },
  );
  const javascriptRemoval = { remove: async () => receipt() };
  await assert.rejects(
    deliverProfessionalCapability('document.actions-javascript', context({ javascriptRemoval, readArtifact: undefined })),
    { code: 'DOCUMENT_ACTIONS_JAVASCRIPT_READBACK_UNAVAILABLE', status: 503 },
  );
  for (const candidate of [
    context({ javascriptRemoval, documentId: '' }),
    context({ javascriptRemoval, sourceSha256: sourceSha256.toUpperCase() }),
    context({ javascriptRemoval, profile: 'inspect-or-author' }),
    context({ javascriptRemoval, signal: {} }),
  ]) {
    await assert.rejects(
      deliverProfessionalCapability('document.actions-javascript', candidate),
      (error) => error.status === 400,
    );
  }
});

test('document.actions-javascript rejects forged receipts and propagates service errors and cancellation', async () => {
  const forged = receipt();
  forged.removal.removedLocus = 'all-actions';
  await assert.rejects(
    deliverProfessionalCapability('document.actions-javascript', context({
      javascriptRemoval: { remove: async () => forged },
    })),
    { code: 'DOCUMENT_ACTIONS_JAVASCRIPT_RECEIPT_INVALID', status: 502 },
  );
  await assert.rejects(
    deliverProfessionalCapability('document.actions-javascript', context({
      javascriptRemoval: { remove: async () => receipt() },
      readArtifact: async () => Buffer.alloc(outputBytes.length),
    })),
    { code: 'DOCUMENT_ACTIONS_JAVASCRIPT_OUTPUT_INVALID', status: 502 },
  );
  const failure = Object.assign(new Error('unsupported'), {
    code: 'PDF_JAVASCRIPT_REMOVAL_SOURCE_UNSUPPORTED', status: 422,
  });
  await assert.rejects(
    deliverProfessionalCapability('document.actions-javascript', context({
      javascriptRemoval: { remove: async () => { throw failure; } },
    })),
    (error) => error === failure,
  );
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    deliverProfessionalCapability('document.actions-javascript', context({
      javascriptRemoval: { remove: async () => receipt() }, signal: controller.signal,
    })),
    { code: 'JOB_CANCELLED', status: 499 },
  );
});
