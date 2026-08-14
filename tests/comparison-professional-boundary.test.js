import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { deliverProfessionalCapability } from '../scripts/host/professional-capability/index.mjs';
import { validateComparisonPackage } from '../scripts/host/comparison-package-contract.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { ComparisonService } from '../scripts/host/comparison-service.mjs';

function sources() {
  const pair = {
    primaryPdf: createTextPdf({ text: 'alpha beta gamma', title: 'primary' }),
    revisionPdf: createTextPdf({ text: 'alpha delta gamma', title: 'revision' }),
  };
  return {
    ...pair,
    primarySha256: createHash('sha256').update(pair.primaryPdf).digest('hex'),
    revisionSha256: createHash('sha256').update(pair.revisionPdf).digest('hex'),
  };
}

test('professional content comparison binds immutable supplied PDFs and validates the semantic receipt', async () => {
  const input = sources();
  const outcome = await deliverProfessionalCapability('compare.content', input);
  const primary = input.primarySha256;
  const revision = input.revisionSha256;

  assert.equal(outcome.method, 'bounded-source-bound-pdf-content-comparison');
  assert.equal(outcome.professionalProof, false);
  assert.deepEqual(outcome.sourceDigests, { primary, revision });
  assert.deepEqual(outcome.inputs, [
    { role: 'primary', sha256: primary },
    { role: 'secondary', sha256: revision },
  ]);
  assert.deepEqual(outcome.stats, {
    added: 1, deleted: 1, unchanged: 2, changed: 2, leftPages: 1, rightPages: 1,
  });
  assert.equal(outcome.semanticValidation, 'validated-content-comparison-receipt');
  assert.equal(input.primaryPdf.equals(createTextPdf({ text: 'alpha beta gamma', title: 'primary' })), true);
});

test('bounded report remains explicitly non-professional and side-by-side has no generic handler', async () => {
  const input = sources();
  const report = await deliverProfessionalCapability('compare.report-export', input);

  assert.equal(report.method, 'bounded-source-bound-comparison-report-export');
  assert.equal(report.professionalProof, false);
  assert.match(report.json, /"primary"/u);
  assert.match(report.csv, /^primarySha256,secondarySha256/u);
  assert.match(report.humanReadable, /1 added, 1 deleted/u);
  await assert.rejects(
    () => deliverProfessionalCapability('compare.side-by-side', input),
    { code: 'PROFESSIONAL_HANDLER_MISSING' },
  );
});

test('professional comparison delegates to the local store-backed service and rechecks source authority', async () => {
  const input = sources();
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const documents = new Map([
    [ids[0], { id: ids[0], mediaType: 'application/pdf', size: input.primaryPdf.length, sha256: input.primarySha256 }],
    [ids[1], { id: ids[1], mediaType: 'application/pdf', size: input.revisionPdf.length, sha256: input.revisionSha256 }],
  ]);
  const store = {
    getDocument(id) { return documents.get(id); },
    async verifySource(id) { assert.ok(documents.has(id)); return true; },
  };
  const service = new ComparisonService({
    store,
    pdfService: {
      async inspect() { return { pageCount: 1 }; },
      async extractText(id) { return [{ page: 1, text: id === ids[0] ? 'alpha beta gamma' : 'alpha delta gamma' }]; },
      async renderThumbnail() { throw new Error('not used'); },
    },
  });
  const outcome = await deliverProfessionalCapability('compare.report-export', {
    store,
    comparisonService: service,
    primaryDocumentId: ids[0],
    revisionDocumentId: ids[1],
    primarySha256: input.primarySha256,
    revisionSha256: input.revisionSha256,
  });

  assert.equal(outcome.method, 'production-local-comparison-report-export');
  assert.equal(outcome.professionalProof, true);
  assert.match(outcome.json, /"secondary"/u);
});

test('professional comparison does not expose a generic overlay proof path', async () => {
  await assert.rejects(
    () => deliverProfessionalCapability('compare.overlay', sources()),
    { code: 'PROFESSIONAL_HANDLER_MISSING' },
  );
});

test('comparison fails closed for empty context, partial pairs, stale digests, synthetic fallback, and cancellation', async () => {
  const input = sources();
  await assert.rejects(
    () => deliverProfessionalCapability('compare.content', {}),
    { code: 'COMPARISON_SOURCE_REQUIRED', status: 400 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('compare.report-export', { primaryPdf: input.primaryPdf }),
    { code: 'COMPARISON_SOURCE_REQUIRED', status: 400 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('compare.package', { ...input, revisionSha256: 'f'.repeat(64) }),
    { code: 'SOURCE_VERSION_MISMATCH', status: 409 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('compare.content', { ...input, demoFixture: true }),
    { code: 'COMPARISON_DEMO_SOURCE_FORBIDDEN', status: 400 },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => deliverProfessionalCapability('compare.package', { ...input, signal: controller.signal }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
});

test('professional comparison package validates a reread package and rejects tampering', async () => {
  const input = sources();
  const outcome = await deliverProfessionalCapability('compare.package', input);
  assert.equal(outcome.professionalProof, false);
  const clean = Buffer.from(outcome.bytes);
  assert.equal(validateComparisonPackage(
    clean, outcome.sourceDigests.primary, outcome.sourceDigests.revision,
  ).manifest.kind, 'local-comparison-package');

  const tampered = Buffer.from(clean);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(
    () => validateComparisonPackage(tampered, outcome.sourceDigests.primary, outcome.sourceDigests.revision),
    { code: 'COMPARISON_PACKAGE_INVALID' },
  );
});

test('professional package promotion requires an injected retained-artifact reread authority', async () => {
  const input = sources();
  const bounded = await deliverProfessionalCapability('compare.package', input);
  const ids = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const store = {
    getDocument(id) {
      return id === ids[0]
        ? { id, mediaType: 'application/pdf', size: input.primaryPdf.length, sha256: input.primarySha256 }
        : id === ids[1]
          ? { id, mediaType: 'application/pdf', size: input.revisionPdf.length, sha256: input.revisionSha256 }
          : undefined;
    },
    async verifySource() { return true; },
  };
  const artifact = { id: 'comparison-artifact', sha256: bounded.outputSha256, size: bounded.bytes.length };
  const context = {
    store,
    packageService: { async create() { return { artifact }; } },
    primaryDocumentId: ids[0], revisionDocumentId: ids[1],
    primarySha256: input.primarySha256, revisionSha256: input.revisionSha256,
  };
  await assert.rejects(
    () => deliverProfessionalCapability('compare.package', context),
    { code: 'COMPARISON_ARTIFACT_READBACK_REQUIRED', status: 503 },
  );
  const outcome = await deliverProfessionalCapability('compare.package', {
    ...context,
    async readArtifact(requested) { assert.equal(requested, artifact); return Buffer.from(bounded.bytes); },
  });
  assert.equal(outcome.professionalProof, true);
  assert.equal(outcome.outputSha256, artifact.sha256);
});
