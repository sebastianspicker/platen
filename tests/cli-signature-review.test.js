import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../scripts/platen-cli.mjs';
import {
  serializeSignatureReview,
  validateSignatureReviewReport,
} from '../scripts/host/signature-review-report.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const SOURCE_DIGEST = 'a'.repeat(64);
const V1_LIMITATIONS = Object.freeze([
  'Certificate trust was not checked.',
  'Revocation, LTV, and trusted timestamps were not checked.',
  'Signer fields are claims embedded in the PDF, not verified identity.',
]);
const baseSignature = Object.freeze({
  index: 1,
  claimedSigner: Object.freeze({ commonName: 'Unverified Claim', distinguishedName: 'CN=Unverified Claim' }),
  claimedSigningTime: 'Jul 20 2026 10:00:00',
  hashAlgorithm: 'SHA-256',
  signatureType: 'adbe.pkcs7.detached',
  byteRange: Object.freeze([0, 100, 200, 50]),
  documentCoverage: 'full',
  integrity: 'valid',
  certificate: 'not-checked',
  revocation: 'not-checked',
  timestamp: 'not-checked',
  identityVerified: false,
});
const v1Evidence = Object.freeze({
  sourceSha256: SOURCE_DIGEST,
  schemaVersion: 1,
  profile: 'poppler-offline-integrity-v1',
  status: 'valid',
  integrityStatus: 'valid',
  coverageStatus: 'full',
  currentDocumentStatus: 'valid',
  count: 1,
  signatureCount: 1,
  summary: '1 embedded signature · valid integrity evidence',
  signatures: Object.freeze([baseSignature]),
  limitations: V1_LIMITATIONS,
});

function v2Evidence(overrides = {}) {
  const evaluatedAt = '2026-07-20T10:00:00.000Z';
  const signature = {
    ...baseSignature,
    certificate: 'fails',
    certificateChain: { status: 'fails', reason: 'not-trusted', chainLength: 1 },
  };
  return {
    ...v1Evidence,
    schemaVersion: 2,
    popplerEvidence: {
      engine: 'Poppler pdfsig', integrityStatus: 'valid', currentDocumentStatus: 'valid',
    },
    cmsCrossCheck: {
      status: 'verified', verifiedCount: 1, indeterminateCount: 0,
      unsupportedCount: 0, reasons: [],
    },
    overallCurrentDocumentStatus: 'valid',
    certificateChainSummary: 'all-fail',
    certificateEvaluation: {
      profile: 'macos-basic-x509-current-trust-v2', evaluatedAt,
      verificationTimeBasis: 'host-current-time',
      anchorBasis: 'current-macos-trust-configuration',
      certificateNetworkFetchAllowed: false,
    },
    signatures: [signature],
    limitations: [
      `Embedded certificate paths were evaluated against this Mac's current trust configuration at ${evaluatedAt}; certificate fetching was disabled.`,
      'Basic X.509 path evaluation does not verify signer identity, PDF-signing key usage, validity at signing time, or trust on another system.',
      'Revocation, OCSP, CRL, LTV, trusted timestamps, certification permissions, and legal effect were not checked.',
      'Signer names and signing times remain unverified claims embedded in the PDF.',
      'Certificate paths are evaluated only after the exact Poppler-dumped CMS verifies against its declared signed byte ranges.',
    ],
    ...overrides,
  };
}

function capture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function signatureApplication(evidence, onVerify = null) {
  let disposed = false;
  return {
    application: {
      store: {
        async createDocument({ stream, displayName }) {
          for await (const _chunk of stream) { /* consume the private upload */ }
          return { id: 'document', displayName, size: 1, sha256: SOURCE_DIGEST };
        },
        async dispose() { disposed = true; },
      },
      service: {
        async verifySignatures(documentId, options) {
          assert.equal(documentId, 'document');
          assert.equal(options.signal instanceof AbortSignal || options.signal === undefined, true);
          onVerify?.();
          return evidence;
        },
      },
    },
    disposed: () => disposed,
  };
}

test('signature-review emits a fixed no-raw v1 report to a private mandatory output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-signature-review-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const outputPath = join(directory, 'signature-review.json');
  await writeFile(input, makeTextPdf('SIGNATURE REVIEW'));
  const fixture = signatureApplication(v1Evidence);
  const output = capture();
  await runCli(['signature-review', input, '--output', outputPath], {
    stdout: output.stream, createApplication: async () => fixture.application,
  });
  const json = await readFile(outputPath, 'utf8');
  const report = JSON.parse(json);
  assert.equal(output.text(), '');
  assert.equal(report.sourceDigest, SOURCE_DIGEST);
  assert.equal(report.evidenceSchemaVersion, 1);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.certificatePathEvaluation.performed, false);
  assert.equal(report.signatures[0].certificatePathStatus, 'not-checked');
  assert.match(report.evaluatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.doesNotMatch(json, /input\.pdf|byteRange|claimedSigner|certificateChain|session/iu);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(fixture.disposed(), true);
});

test('signature-review preserves bounded enriched-v2 status without widening certificate claims', () => {
  const evidence = v2Evidence();
  const report = serializeSignatureReview(evidence, { evaluatedAt: '2026-07-20T11:00:00.000Z' });
  const validated = validateSignatureReviewReport(report, { expectedSourceDigest: SOURCE_DIGEST });
  assert.equal(validated.certificatePathEvaluation.performed, true);
  assert.equal(validated.certificatePathEvaluation.profile, 'macos-basic-x509-current-trust-v2');
  assert.equal(validated.certificatePathEvaluation.evaluatedAt, '2026-07-20T10:00:00.000Z');
  assert.equal(validated.certificatePathEvaluation.verificationTimeBasis, 'host-current-time');
  assert.equal(validated.certificatePathEvaluation.anchorBasis, 'current-macos-trust-configuration');
  assert.equal(validated.certificatePathEvaluation.certificateNetworkFetchAllowed, false);
  assert.deepEqual(validated.certificatePathEvaluation.exactCmsCrossCheck, {
    status: 'verified', verifiedCount: 1, indeterminateCount: 0, unsupportedCount: 0,
  });
  assert.equal(validated.integrity.combinedCurrentDocumentStatus, 'valid');
  assert.equal(validated.signatures[0].certificatePathStatus, 'fails');
  assert.doesNotMatch(JSON.stringify(validated), /not-trusted|chainLength|claimedSigner|byteRange/u);
});

test('signature-review cancellation and malformed evidence leave no output residue', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-signature-cancel-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const outputPath = join(directory, 'signature-review.json');
  await writeFile(input, makeTextPdf('SIGNATURE CANCELLATION'));
  const controller = new AbortController();
  const cancelledFixture = signatureApplication(v1Evidence, () => controller.abort());
  await assert.rejects(runCli(['signature-review', input, '--output', outputPath], {
    stdout: capture().stream, createApplication: async () => cancelledFixture.application, signal: controller.signal,
  }), { code: 'JOB_CANCELLED' });
  await assert.rejects(access(outputPath), { code: 'ENOENT' });
  assert.equal(cancelledFixture.disposed(), true);

  const malformedFixture = signatureApplication({ ...v1Evidence, sourceSha256: 'b'.repeat(64) });
  await assert.rejects(runCli(['signature-review', input, '--output', outputPath], {
    stdout: capture().stream, createApplication: async () => malformedFixture.application,
  }), { code: 'SIGNATURE_REVIEW_INVALID', status: 502 });
  await assert.rejects(access(outputPath), { code: 'ENOENT' });
  assert.equal(malformedFixture.disposed(), true);
});

test('signature review snapshots descriptors before access and rejects hostile JSON shapes', () => {
  let propertyReads = 0;
  const proxy = new Proxy(v1Evidence, {
    get(target, key, receiver) {
      propertyReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(() => serializeSignatureReview(proxy), { code: 'SIGNATURE_REVIEW_INVALID' });
  assert.equal(propertyReads, 0);

  let getterReads = 0;
  const accessor = structuredClone(v1Evidence);
  Object.defineProperty(accessor, 'status', {
    enumerable: true,
    get() { getterReads += 1; return 'valid'; },
  });
  assert.throws(() => serializeSignatureReview(accessor), { code: 'SIGNATURE_REVIEW_INVALID' });
  assert.equal(getterReads, 0);

  const symbol = structuredClone(v1Evidence);
  symbol[Symbol('raw')] = '/private/raw.cms';
  const exotic = Object.assign(Object.create({ inherited: true }), structuredClone(v1Evidence));
  const cycle = structuredClone(v1Evidence);
  cycle.self = cycle;
  const sparse = structuredClone(v1Evidence);
  sparse.signatures = new Array(1);
  const jsonHook = structuredClone(v1Evidence);
  jsonHook.toJSON = () => ({ raw: '/private/raw.cms' });
  for (const value of [symbol, exotic, cycle, sparse, jsonHook]) {
    assert.throws(() => serializeSignatureReview(value), { code: 'SIGNATURE_REVIEW_INVALID' });
  }

  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true, value: () => ({ raw: '/private/raw.cms' }),
  });
  try {
    assert.throws(() => serializeSignatureReview(v1Evidence), { code: 'SIGNATURE_REVIEW_INVALID' });
  } finally {
    delete Object.prototype.toJSON;
  }
});

test('signature review rejects contradictory v1 summaries and unsafe retained tokens', () => {
  const values = [];
  const invalidStatus = structuredClone(v1Evidence);
  invalidStatus.status = 'invalid';
  values.push(invalidStatus);
  const invalidCoverage = structuredClone(v1Evidence);
  invalidCoverage.coverageStatus = 'mixed';
  values.push(invalidCoverage);
  const invalidCount = structuredClone(v1Evidence);
  invalidCount.signatureCount = 2;
  values.push(invalidCount);
  const invalidIndex = structuredClone(v1Evidence);
  invalidIndex.signatures[0].index = 2;
  values.push(invalidIndex);
  const unsafeHash = structuredClone(v1Evidence);
  unsafeHash.signatures[0].hashAlgorithm = '/private/raw.cms';
  values.push(unsafeHash);
  const unsafeType = structuredClone(v1Evidence);
  unsafeType.signatures[0].signatureType = 'adbe.pkcs7.detached\n/private/raw.cms';
  values.push(unsafeType);
  for (const value of values) {
    assert.throws(() => serializeSignatureReview(value), { code: 'SIGNATURE_REVIEW_INVALID' });
  }
});

test('signature review derives and checks all enriched evidence relationships', () => {
  const invalidCmsCounts = v2Evidence({
    cmsCrossCheck: {
      status: 'verified', verifiedCount: 0, indeterminateCount: 0,
      unsupportedCount: 0, reasons: [],
    },
  });
  const invalidCombined = v2Evidence({ overallCurrentDocumentStatus: 'indeterminate' });
  const invalidProfile = v2Evidence();
  invalidProfile.certificateEvaluation.profile = 'full-certificate-validation';
  const invalidBasis = v2Evidence();
  invalidBasis.certificateEvaluation.verificationTimeBasis = 'signing-time';
  const invalidAnchor = v2Evidence();
  invalidAnchor.certificateEvaluation.anchorBasis = 'embedded-roots';
  const fetching = v2Evidence();
  fetching.certificateEvaluation.certificateNetworkFetchAllowed = true;
  const noncanonicalTime = v2Evidence();
  noncanonicalTime.certificateEvaluation.evaluatedAt = '2026-02-31T10:00:00.000Z';
  for (const value of [
    invalidCmsCounts, invalidCombined, invalidProfile, invalidBasis,
    invalidAnchor, fetching, noncanonicalTime,
  ]) {
    assert.throws(
      () => serializeSignatureReview(value, { evaluatedAt: '2026-07-20T11:00:00.000Z' }),
      { code: 'SIGNATURE_REVIEW_INVALID' },
    );
  }
});

test('signature report validator independently rejects semantic contradictions and hostile reports', () => {
  const issued = serializeSignatureReview(v2Evidence(), {
    evaluatedAt: '2026-07-20T11:00:00.000Z',
  });
  const invalidIntegrity = structuredClone(issued);
  invalidIntegrity.integrity.status = 'invalid';
  const invalidCmsCounts = structuredClone(issued);
  invalidCmsCounts.certificatePathEvaluation.exactCmsCrossCheck.verifiedCount = 0;
  const invalidSummary = structuredClone(issued);
  invalidSummary.certificatePathEvaluation.summary = 'all-pass';
  const unsafeType = structuredClone(issued);
  unsafeType.signatures[0].signatureType = '/private/raw.cms';
  for (const report of [invalidIntegrity, invalidCmsCounts, invalidSummary, unsafeType]) {
    assert.throws(() => validateSignatureReviewReport(report, {
      expectedSourceDigest: SOURCE_DIGEST, requireTrustedIssue: false,
    }), { code: 'SIGNATURE_REVIEW_INVALID' });
  }

  let getterReads = 0;
  const accessor = structuredClone(issued);
  Object.defineProperty(accessor, 'profile', {
    enumerable: true,
    get() { getterReads += 1; return 'offline-embedded-signature-review-v2'; },
  });
  assert.throws(() => validateSignatureReviewReport(accessor, {
    expectedSourceDigest: SOURCE_DIGEST, requireTrustedIssue: false,
  }), { code: 'SIGNATURE_REVIEW_INVALID' });
  assert.equal(getterReads, 0);
  assert.throws(() => serializeSignatureReview(v1Evidence, {
    evaluatedAt: '2026-02-31T10:00:00.000Z',
  }), { code: 'SIGNATURE_REVIEW_INVALID' });
});
