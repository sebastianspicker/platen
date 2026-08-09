import assert from 'node:assert/strict';
import test from 'node:test';
import { createSigningEndpoints } from '../src/core/local-host-signing-endpoints.js';

const DOCUMENT_ID = '123e4567-e89b-12d3-a456-426614174000';
const SOURCE = 'a'.repeat(64);
const LIMITATIONS = [
  'Certificate trust was not checked.',
  'Revocation, LTV, and trusted timestamps were not checked.',
  'Signer fields are claims embedded in the PDF, not verified identity.',
];

function signature(overrides = {}) {
  return {
    index: 1,
    claimedSigner: { commonName: 'Unverified Claim', distinguishedName: 'CN=Unverified Claim' },
    claimedSigningTime: 'Jul 20 2026 10:00:00',
    hashAlgorithm: 'SHA-256',
    signatureType: 'adbe.pkcs7.detached',
    byteRange: [0, 100, 200, 50],
    documentCoverage: 'full',
    integrity: 'valid',
    certificate: 'not-checked',
    revocation: 'not-checked',
    timestamp: 'not-checked',
    identityVerified: false,
    ...overrides,
  };
}

function v1Evidence(overrides = {}) {
  const signatures = overrides.signatures ?? [];
  const status = signatures.length === 0 ? 'unsigned' : signatures.some(({ integrity }) => integrity === 'invalid') ? 'invalid' : 'valid';
  const coverage = signatures.length === 0 ? 'unsigned' : signatures.every(({ documentCoverage }) => documentCoverage === 'full') ? 'full' : 'prior-revision';
  const currentDocumentStatus = status === 'unsigned' || status === 'invalid' ? status : coverage === 'full' ? 'valid' : 'modified-after-signing';
  return {
    sourceSha256: SOURCE,
    schemaVersion: 1,
    profile: 'poppler-offline-integrity-v1',
    status,
    integrityStatus: status,
    coverageStatus: coverage,
    currentDocumentStatus,
    count: signatures.length,
    signatureCount: signatures.length,
    summary: status === 'unsigned' ? 'No embedded signatures' : `${signatures.length} embedded signature${signatures.length === 1 ? '' : 's'} · ${status} integrity evidence`,
    signatures,
    limitations: LIMITATIONS,
    ...overrides,
  };
}

function v2Evidence(chain = { status: 'passes', reason: 'none', chainLength: 2 }, overrides = {}) {
  const item = signature({ certificate: chain.status, certificateChain: chain });
  const crossCheck = chain.status === 'indeterminate'
    ? { status: 'indeterminate', verifiedCount: 0, indeterminateCount: 1, unsupportedCount: 0, reasons: [chain.reason] }
    : { status: 'verified', verifiedCount: 1, indeterminateCount: 0, unsupportedCount: 0, reasons: [] };
  const evidence = v1Evidence({
    schemaVersion: 2,
    signatures: [item],
    popplerEvidence: { engine: 'Poppler pdfsig', integrityStatus: 'valid', currentDocumentStatus: 'valid' },
    cmsCrossCheck: crossCheck,
    overallCurrentDocumentStatus: crossCheck.status === 'verified' ? 'valid' : 'indeterminate',
    certificateChainSummary: chain.status === 'passes' ? 'all-pass' : chain.status === 'fails' ? 'all-fail' : 'indeterminate',
    certificateEvaluation: {
      profile: 'macos-basic-x509-current-trust-v2',
      evaluatedAt: '2026-07-20T10:00:00.000Z',
      verificationTimeBasis: 'host-current-time',
      anchorBasis: 'current-macos-trust-configuration',
      certificateNetworkFetchAllowed: false,
    },
    limitations: [
      'Embedded certificate paths were evaluated against this Mac current trust configuration; certificate fetching was disabled.',
    ],
    ...overrides,
  });
  return evidence;
}

function endpointFor(body, calls = []) {
  return createSigningEndpoints({
    json(path, options) {
      calls.push({ path, options });
      return Promise.resolve(body);
    },
  });
}

test('validateCertificateSignatures requests the authenticated GET with an optional signal', async () => {
  const calls = [];
  const controller = new AbortController();
  const evidence = v1Evidence();
  const result = await endpointFor({ signatures: evidence }, calls).validateCertificateSignatures(DOCUMENT_ID, { signal: controller.signal });
  assert.equal(calls[0].path, `/api/documents/${DOCUMENT_ID}/signatures`);
  assert.deepEqual(calls[0].options, { method: 'GET', signal: controller.signal });
  assert.deepEqual(result, evidence);
});

test('validateCertificateSignatures accepts v1 unsigned and invalid evidence', async () => {
  assert.equal((await endpointFor({ signatures: v1Evidence() }).validateCertificateSignatures(DOCUMENT_ID)).status, 'unsigned');
  const invalid = v1Evidence({ signatures: [signature({ integrity: 'invalid' })] });
  assert.equal((await endpointFor({ signatures: invalid }).validateCertificateSignatures(DOCUMENT_ID)).status, 'invalid');
});

test('validateCertificateSignatures accepts v2 pass, fail, and indeterminate certificate paths', async () => {
  const pass = await endpointFor({ signatures: v2Evidence() }).validateCertificateSignatures(DOCUMENT_ID);
  assert.equal(pass.signatures[0].certificate, 'passes');
  const fail = await endpointFor({ signatures: v2Evidence({ status: 'fails', reason: 'not-trusted', chainLength: 1 }) }).validateCertificateSignatures(DOCUMENT_ID);
  assert.equal(fail.certificateChainSummary, 'all-fail');
  const indeterminate = await endpointFor({ signatures: v2Evidence({ status: 'indeterminate', reason: 'cms-signature-mismatch', chainLength: null }) }).validateCertificateSignatures(DOCUMENT_ID);
  assert.equal(indeterminate.overallCurrentDocumentStatus, 'indeterminate');
});

test('validateCertificateSignatures rejects forged relationships and hostile object graphs', async () => {
  const invalidCount = v1Evidence({ signatureCount: 1 });
  const invalidDigest = v1Evidence({ sourceSha256: SOURCE.toUpperCase() });
  const invalidChain = v2Evidence({ status: 'fails', reason: 'none', chainLength: 1 });
  const proxy = new Proxy(v1Evidence(), { get() { throw new Error('must not read proxy'); } });
  const accessor = v1Evidence();
  Object.defineProperty(accessor, 'status', { enumerable: true, get() { throw new Error('must not read accessor'); } });
  const responseAccessor = {};
  Object.defineProperty(responseAccessor, 'signatures', { enumerable: true, get() { throw new Error('must not read response accessor'); } });
  const symbol = v1Evidence(); symbol[Symbol('private')] = '/private/raw.cms';
  const malformedPath = v1Evidence({ limitations: ['/private/raw.cms'] });
  for (const body of [invalidCount, invalidDigest, invalidChain, proxy, accessor, responseAccessor, symbol, malformedPath]) {
    const response = body === responseAccessor ? body : { signatures: body };
    await assert.rejects(endpointFor(response).validateCertificateSignatures(DOCUMENT_ID), TypeError);
  }
});

test('validateCertificateSignatures returns a detached deeply frozen snapshot', async () => {
  const body = { signatures: v2Evidence() };
  const result = await endpointFor(body).validateCertificateSignatures(DOCUMENT_ID);
  body.signatures.signatures[0].claimedSigner.commonName = 'changed';
  assert.equal(result.signatures[0].claimedSigner.commonName, 'Unverified Claim');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.signatures), true);
  assert.equal(Object.isFrozen(result.signatures[0].claimedSigner), true);
  assert.throws(() => { result.signatures[0].claimedSigner.commonName = 'changed'; }, TypeError);
});
