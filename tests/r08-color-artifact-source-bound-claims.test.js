import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HostError } from '../scripts/host/host-error.mjs';
import { OUTPUT_INTENT_PROFILE } from '../scripts/host/prepress/output-intent-contract.mjs';
import { deliverProfessionalCapability, listProfessionalHandlers } from '../scripts/host/professional-capability/index.mjs';
import { colorConvert } from '../scripts/host/professional-capability/standards-preflight-color.mjs';
import { createProfessionalPrintDelivery } from '../scripts/host/professional-capability/standards-preflight-print-core.mjs';

const profileSha256 = 'b'.repeat(64);
const profileSize = 187484;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceFailure() {
  return new HostError('SOURCE_INTEGRITY_FAILED', 'The test source changed after service delivery.', 500);
}

function outputIntentResult(source, artifact, overrides = {}) {
  return {
    kind: 'output-intent-artifact',
    sourceDigest: source.sha256,
    artifact: {
      id: artifact.id,
      documentId: source.id,
      sha256: artifact.sha256,
      size: artifact.size,
      operation: {
        type: 'ghostscript-cmyk-output-intent',
        inputs: [{ documentId: source.id, sha256: source.sha256, role: 'source' }],
        parameters: { profileId: 'ghostscript-default-cmyk', profileSha256, profileBytes: profileSize, outputIntentSubtype: 'GTS_PDFX' },
        expected: { embeddedProfileSha256: profileSha256, outputIntentCount: 1 },
        validation: { passed: true, outputSha256: artifact.sha256, profileSha256 },
      },
    },
    profile: { id: 'ghostscript-default-cmyk', colorSpace: 'CMYK', sha256: profileSha256, size: profileSize },
    proof: {
      schema: 'pdf-output-intent-assignment-proof-v1', sourceSha256: source.sha256, outputSha256: artifact.sha256,
      profileSha256, profileBytes: profileSize, outputIntentCount: 1,
      closedClassicRevision: true, priorRevisionsAbsent: true,
    },
    receipt: {
      outputSha256: artifact.sha256, outputIntentCount: 1, pageGeometryPreserved: true,
      textExtractionEquivalent: true, everyPageRendered: true, pdfXValidated: false,
    },
    ...overrides,
  };
}

function conversionResult(source, artifact, overrides = {}) {
  return {
    kind: 'icc-cmyk-artifact', schemaVersion: 1, sourceDigest: source.sha256,
    artifact: {
      id: artifact.id, documentId: source.id, sha256: artifact.sha256, size: artifact.size, mediaType: 'application/pdf',
      operation: {
        type: 'ghostscript-icc-cmyk',
        inputs: [{ documentId: source.id, sha256: source.sha256, role: 'source' }],
        parameters: {
          profileId: 'ghostscript-default-cmyk', profileSha256,
          renderingIntent: 'relative-colorimetric', blackPointCompensation: true,
          preserveSeparations: true, overrideEmbeddedIcc: false,
        },
        expected: { pageCount: 1, outputColorSpace: 'CMYK-targeted', rasterized: false },
        validation: {
          passed: true, outputSha256: artifact.sha256, pageCount: 1, textSha256: source.sha256,
          validators: [
            'source-sha256', 'icc-header-and-tags', 'icc-profile-sha256',
            'ghostscript-exit-zero', 'poppler-page-count', 'poppler-page-boxes',
            'poppler-passive-content', 'poppler-text-equivalence',
            'poppler-render-all-pages', 'artifact-sha256',
          ],
        },
      },
    },
    profile: { id: 'ghostscript-default-cmyk', colorSpace: 'CMYK', sha256: profileSha256 },
    recipe: { colorConversionStrategy: 'CMYK' },
    receipt: {
      outputSha256: artifact.sha256, pageCount: 1, pageGeometryPreserved: true,
      textExtractionEquivalent: true, everyPageRendered: true,
      outputIntentEmbeddedOrValidated: false, pdfXValidated: false,
    },
    authoritative: false,
    limitations: [
      'This is CMYK-targeted normalization through an exact local ICC profile, not PDF/X, GWG, Ghent, or press certification.',
      'Ghostscript does not colorimetrically retarget existing DeviceCMYK values; Separation and DeviceN colorants are preserved rather than eliminated.',
      'No PDF OutputIntent is assigned or validated, and complex transparency, optional content, annotations, links, and metadata may be rewritten.',
    ],
    serviceEvidence: { fixture: true },
    ...overrides,
  };
}

async function fixture(t, { assign = null, convert = null, failVerificationAt = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r08-color-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourceBytes = Buffer.from('%PDF-1.7\nR08 COLOR SOURCE\n%%EOF\n', 'ascii');
  const artifactBytes = Buffer.from('%PDF-1.7\n/OutputIntents [/OutputIntent /GTS_PDFX /N 4]\n%%EOF\n', 'ascii');
  const sourcePath = join(root, 'source.pdf');
  const artifactPath = join(root, 'artifact.pdf');
  await Promise.all([writeFile(sourcePath, sourceBytes), writeFile(artifactPath, artifactBytes)]);
  const source = Object.freeze({ id: 'r08-source', sha256: digest(sourceBytes), size: sourceBytes.length });
  const artifact = { id: 'r08-artifact', documentId: source.id, sha256: digest(artifactBytes), size: artifactBytes.length, filePath: artifactPath };
  const artifacts = new Map([[artifact.id, artifact]]);
  const deleted = [];
  const calls = { assign: [], convert: [] };
  let verificationCount = 0;
  const store = {
    async verifySource(id) {
      assert.equal(id, source.id);
      verificationCount += 1;
      if (verificationCount === failVerificationAt) throw sourceFailure();
      return true;
    },
    getDocument(id) {
      assert.equal(id, source.id);
      return source;
    },
    getSourcePath(id) {
      assert.equal(id, source.id);
      return sourcePath;
    },
    getArtifact(id) {
      const found = artifacts.get(id);
      if (!found) throw new HostError('ARTIFACT_NOT_FOUND', 'The retained artifact was revoked.', 404);
      return found;
    },
    async deleteArtifact(id) {
      deleted.push(id);
      artifacts.delete(id);
    },
  };
  const prepress = {
    async assignOutputIntent(documentId, request, options) {
      calls.assign.push({ documentId, request, options });
      return assign ? assign({ source, artifact, artifactPath, request, options }) : outputIntentResult(source, artifact);
    },
    async convertToCmyk(documentId, options) {
      calls.convert.push({ documentId, options });
      return convert ? convert({ source, artifact, artifactPath, options }) : conversionResult(source, artifact);
    },
  };
  const professional = createProfessionalPrintDelivery({
    store, services: { prepress }, deliver: deliverProfessionalCapability, list: listProfessionalHandlers,
  });
  return { artifact, artifactBytes, artifactPath, calls, deleted, prepress, professional, source, store };
}

test('R08 composition-root delivery binds color requests to the current document and retained OutputIntent artifact', async (t) => {
  const value = await fixture(t);
  const outcome = await value.professional.deliver('color.output-intents', {
    documentId: value.source.id,
    sourceSha256: value.source.sha256,
    prepress: { async assignOutputIntent() { throw new Error('caller service must not run'); } },
  });

  assert.deepEqual(value.calls.assign, [{
    documentId: value.source.id,
    request: { profile: OUTPUT_INTENT_PROFILE, sourceSha256: value.source.sha256 },
    options: { signal: undefined },
  }]);
  assert.equal(outcome.outputSha256, value.artifact.sha256);
  assert.deepEqual(outcome.pdf, value.artifactBytes);
  assert.equal(outcome.bytes, value.artifact.size);
  assert.deepEqual(value.deleted, []);
});

test('R08 OutputIntent source-digest, proof, and retained-artifact drift fail closed and revoke the artifact', async (t) => {
  const cases = [
    {
      name: 'source digest',
      assign: ({ source, artifact }) => outputIntentResult(source, artifact, { sourceDigest: 'c'.repeat(64) }),
      code: 'OUTPUT_INTENT_SERVICE_INVALID',
    },
    {
      name: 'proof',
      assign: ({ source, artifact }) => outputIntentResult(source, artifact, {
        proof: { ...outputIntentResult(source, artifact).proof, profileSha256: 'd'.repeat(64) },
      }),
      code: 'OUTPUT_INTENT_SERVICE_INVALID',
    },
    {
      name: 'retained bytes',
      assign: async ({ source, artifact, artifactPath }) => {
        await writeFile(artifactPath, Buffer.from('%PDF-1.7\nTAMPERED\n%%EOF\n', 'ascii'));
        return outputIntentResult(source, artifact);
      },
      code: 'OUTPUT_INTENT_ARTIFACT_REVOKED',
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const value = await fixture(subtest, { assign: scenario.assign });
      await assert.rejects(
        () => value.professional.deliver('color.output-intents', { documentId: value.source.id, sourceSha256: value.source.sha256 }),
        { code: scenario.code },
      );
      assert.deepEqual(value.deleted, [value.artifact.id]);
    });
  }
});

test('R08 cancellation after OutputIntent service return revokes its retained artifact', async (t) => {
  const controller = new AbortController();
  const value = await fixture(t, {
    assign: ({ source, artifact }) => {
      controller.abort();
      return outputIntentResult(source, artifact);
    },
  });
  await assert.rejects(
    () => value.professional.deliver('color.output-intents', { documentId: value.source.id, sourceSha256: value.source.sha256, signal: controller.signal }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
  assert.deepEqual(value.deleted, [value.artifact.id]);
});

test('R08 post-service source failure revokes the color-conversion output recognized by print delivery', async (t) => {
  const value = await fixture(t, { failVerificationAt: 3 });
  await assert.rejects(
    () => value.professional.deliver('color.convert', {
      documentId: value.source.id,
      sourceSha256: value.source.sha256,
      prepress: { async convertToCmyk() { throw new Error('caller service must not run'); } },
    }),
    { code: 'SOURCE_INTEGRITY_FAILED', status: 500 },
  );
  assert.deepEqual(value.calls.convert.map(({ documentId, options }) => ({ documentId, profile: options.profile })), [{
    documentId: value.source.id, profile: 'ghostscript-default-cmyk',
  }]);
  assert.deepEqual(value.deleted, [value.artifact.id]);
});

test('R08 color conversion rejects forged provenance, receipt, and retained-byte drift after service delivery', async (t) => {
  const cases = [
    {
      name: 'provenance',
      convert: ({ source, artifact }) => conversionResult(source, artifact, {
        artifact: { ...conversionResult(source, artifact).artifact, operation: { ...conversionResult(source, artifact).artifact.operation, type: 'forged-cmyk' } },
      }),
      code: 'COLOR_CONVERSION_SERVICE_INVALID',
    },
    {
      name: 'receipt',
      convert: ({ source, artifact }) => conversionResult(source, artifact, {
        receipt: { ...conversionResult(source, artifact).receipt, everyPageRendered: false },
      }),
      code: 'COLOR_CONVERSION_SERVICE_INVALID',
    },
    {
      name: 'retained bytes',
      convert: async ({ source, artifact, artifactPath }) => {
        await writeFile(artifactPath, Buffer.from('%PDF-1.7\nTAMPERED CMYK\n%%EOF\n', 'ascii'));
        return conversionResult(source, artifact);
      },
      code: 'COLOR_CONVERSION_ARTIFACT_REVOKED',
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const value = await fixture(subtest, { convert: scenario.convert });
      await assert.rejects(
        () => value.professional.deliver('color.convert', { documentId: value.source.id, sourceSha256: value.source.sha256 }),
        { code: scenario.code },
      );
      assert.deepEqual(value.deleted, [value.artifact.id]);
    });
  }
});

test('R08 color conversion rejects a forged opaque authority directly', async () => {
  await assert.rejects(
    () => colorConvert({
      documentId: 'r08-source', sourceSha256: 'a'.repeat(64),
      prepress: { async convertToCmyk() { throw new Error('must not run'); } },
      printAuthority: { store: {}, prepress: {} },
    }),
    { code: 'INVALID_PRODUCTION_AUTHORITY', status: 503 },
  );
});
