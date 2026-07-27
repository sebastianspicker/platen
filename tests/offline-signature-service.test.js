import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import {
  OfflineSignatureService,
  SIGNATURE_TRUST_LIMITS,
} from '../scripts/host/offline-signature-service.mjs';
import {
  serializeSignatureReview,
  validateSignatureReviewReport,
} from '../scripts/host/signature-review-report.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const dumpedCms = Buffer.from('30800000', 'hex');
const dumpedCmsSha256 = createHash('sha256').update(dumpedCms).digest('hex');
const signatureToken = Buffer.from(`<${dumpedCms.toString('hex')}>`, 'ascii');
const signedFixtureBytes = Buffer.from(makeTextPdf('IMMUTABLE SIGNATURE SOURCE'));
const signatureTokenOffset = 100;
signatureToken.copy(signedFixtureBytes, signatureTokenOffset);
const signatureByteRange = Object.freeze([
  0,
  signatureTokenOffset,
  signatureTokenOffset + signatureToken.length,
  signedFixtureBytes.length - signatureTokenOffset - signatureToken.length,
]);

function pdfsigOutput(input) {
  return [
    `Digital Signature Info of: ${input}`,
    'Signature #1:',
    '  - Signature Field Name: private-field-name',
    '  - Signer Certificate Common Name: Unverified Claim',
    '  - Signer full Distinguished Name: CN=Unverified Claim',
    '  - Signing Time: Jul 19 2026 10:00:00',
    '  - Signing Hash Algorithm: SHA-256',
    '  - Signature Type: adbe.pkcs7.detached',
    `  - Signed Ranges: [0 - ${signatureByteRange[1]}], [${signatureByteRange[2]} - ${signedFixtureBytes.length}]`,
    '  - Total document signed',
    '  - Signature Validation: Signature is Valid.',
    '',
  ].join('\n');
}

function nativeEvidence(sourceSha256, overrides = {}) {
  return {
    schema: 'macos-signature-chain-receipt-v2',
    profile: 'macos-basic-x509-current-trust-v2',
    sourceSha256,
    evaluatedAt: '2026-07-19T10:00:00.000Z',
    verificationTimeBasis: 'host-current-time',
    anchorBasis: 'current-macos-trust-configuration',
    certificateNetworkFetchAllowed: false,
    records: [{
      byteRange: [...signatureByteRange],
      subFilter: 'adbe.pkcs7.detached',
      cmsSha256: dumpedCmsSha256,
      certificateChain: { status: 'fails', reason: 'not-trusted', chainLength: 1 },
    }],
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'offline-signature-service-'));
  await chmod(root, 0o700);
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => {
    await store.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from(signedFixtureBytes);
  const document = await store.createDocument({
    stream: Readable.from([bytes]), displayName: 'signed.pdf', mediaType: 'application/pdf',
  });
  return { root, store, document, bytes };
}

test('offline signature service binds Poppler and native chain evidence to one private source copy', async (t) => {
  const { root, store, document, bytes } = await fixture(t);
  const storedPath = store.getSourcePath(document.id);
  let popplerInput;
  let trustWorkspace;
  const poppler = {
    async execute(operation, parameters, options) {
      assert.notEqual(parameters.input, storedPath);
      assert.deepEqual(await readFile(parameters.input), bytes);
      popplerInput = parameters.input;
      if (operation === 'dumpSignatures') {
        await writeFile(join(options.cwd, 'input.pdf.sig0'), dumpedCms);
        return { stdout: `Dumping Signatures: 1\nSignature #0 (4 bytes) => input.pdf.sig0\n`, stderr: '', exitCode: 0 };
      }
      assert.equal(operation, 'verifySignatures');
      assert.equal(parameters.nssDirectory, options.cwd);
      return { stdout: pdfsigOutput(parameters.input), stderr: '', exitCode: 0 };
    },
  };
  const trust = {
    async evaluate({ workspacePath, requestPath }, options) {
      trustWorkspace = workspacePath;
      assert.equal(popplerInput, join(workspacePath, 'input.pdf'));
      assert.equal(requestPath, join(workspacePath, 'request.json'));
      assert.equal((await stat(popplerInput)).mode & 0o777, 0o400);
      assert.equal((await stat(requestPath)).mode & 0o777, 0o400);
      assert.equal((await stat(join(workspacePath, 'dumps/input.pdf.sig0'))).mode & 0o777, 0o400);
      assert.equal(options.timeoutMs, 30_000);
      assert.deepEqual(JSON.parse(await readFile(requestPath, 'utf8')), {
        version: 1,
        operation: 'validateEmbeddedCertificateChains',
        inputFilename: 'input.pdf',
        sourceSha256: document.sha256,
        limits: SIGNATURE_TRUST_LIMITS,
        records: [{
          byteRange: [...signatureByteRange],
          subFilter: 'adbe.pkcs7.detached',
          cmsFilename: 'dumps/input.pdf.sig0',
          cmsSha256: dumpedCmsSha256,
        }],
      });
      return nativeEvidence(document.sha256);
    },
  };
  const result = await new OfflineSignatureService({ store, poppler, trust }).verify(document.id);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.status, 'valid');
  assert.equal(result.currentDocumentStatus, 'valid');
  assert.deepEqual(result.popplerEvidence, {
    engine: 'Poppler pdfsig', integrityStatus: 'valid', currentDocumentStatus: 'valid',
  });
  assert.deepEqual(result.cmsCrossCheck, {
    status: 'verified', verifiedCount: 1, indeterminateCount: 0, unsupportedCount: 0, reasons: [],
  });
  assert.equal(result.overallCurrentDocumentStatus, 'valid');
  assert.equal(result.certificateChainSummary, 'all-fail');
  assert.deepEqual(result.signatures[0].certificateChain, {
    status: 'fails', reason: 'not-trusted', chainLength: 1,
  });
  assert.equal(result.signatures[0].identityVerified, false);
  assert.equal(result.signatures[0].revocation, 'not-checked');
  assert.equal(result.signatures[0].timestamp, 'not-checked');
  assert.doesNotMatch(JSON.stringify(result), /private-field-name|offline-signature-service-/u);
  const report = serializeSignatureReview(result, { evaluatedAt: '2026-07-19T11:00:00.000Z' });
  assert.equal(validateSignatureReviewReport(report, {
    expectedSourceDigest: document.sha256,
  }), report);
  assert.equal(report.certificatePathEvaluation.summary, 'all-fail');
  assert.doesNotMatch(JSON.stringify(report), /private-field-name|byteRange|not-trusted/u);
  assert.deepEqual(await readFile(storedPath), bytes);
  await assert.rejects(stat(trustWorkspace), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(root, 'jobs')), []);
});

test('invalid or indeterminate Poppler evidence never starts CMS extraction or native enrichment', async (t) => {
  const { store, document } = await fixture(t);
  for (const [validation, expectedStatus] of [
    ['Signature is Invalid.', 'invalid'],
    ['Signature not found.', 'indeterminate'],
  ]) {
    const operations = [];
    const result = await new OfflineSignatureService({
      store,
      poppler: {
        async execute(operation, parameters) {
          operations.push(operation);
          assert.equal(operation, 'verifySignatures');
          const output = pdfsigOutput(parameters.input).replace('Signature is Valid.', validation);
          if (expectedStatus === 'invalid') {
            throw Object.assign(new Error('invalid signature'), {
              stdout: output, stderr: '', exitCode: 1,
            });
          }
          return { stdout: output, stderr: '', exitCode: 0 };
        },
      },
      trust: { async evaluate() { throw new Error('native enrichment must not execute'); } },
    }).verify(document.id);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(operations, ['verifySignatures']);
    assert.equal('cmsCrossCheck' in result, false);
  }
});

test('certificate-path mismatch stays indeterminate and cannot override integrity evidence', async (t) => {
  const { store, document } = await fixture(t);
  const poppler = {
    async execute(operation, parameters, options) {
      if (operation === 'dumpSignatures') {
        await writeFile(join(options.cwd, 'input.pdf.sig0'), dumpedCms);
        return { stdout: `Dumping Signatures: 1\nSignature #0 (4 bytes) => input.pdf.sig0\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: pdfsigOutput(parameters.input), stderr: '', exitCode: 0 };
    },
  };
  const mismatch = new OfflineSignatureService({
    store,
    poppler,
    trust: {
      async evaluate() {
        return nativeEvidence(document.sha256, {
          records: [{
            byteRange: [0, signatureByteRange[1] + 1, signatureByteRange[2], signatureByteRange[3]],
            subFilter: 'adbe.pkcs7.detached',
            cmsSha256: dumpedCmsSha256,
            certificateChain: { status: 'passes', reason: 'none', chainLength: 2 },
          }],
        });
      },
    },
  });
  const result = await mismatch.verify(document.id);
  assert.equal(result.status, 'valid');
  assert.equal(result.currentDocumentStatus, 'valid');
  assert.equal(result.overallCurrentDocumentStatus, 'indeterminate');
  assert.deepEqual(result.cmsCrossCheck, {
    status: 'indeterminate', verifiedCount: 0, indeterminateCount: 1,
    unsupportedCount: 0, reasons: ['evidence-mismatch'],
  });
  assert.equal(result.certificateChainSummary, 'indeterminate');
  assert.deepEqual(result.signatures[0].certificateChain, {
    status: 'indeterminate', reason: 'evidence-mismatch', chainLength: null,
  });

  const unavailable = await new OfflineSignatureService({
    store,
    poppler,
    trust: { async evaluate() { throw new Error('/private/native failure'); } },
  }).verify(document.id);
  assert.equal(unavailable.schemaVersion, 1);
  assert.equal(unavailable.signatures[0].certificate, 'not-checked');
  assert.doesNotMatch(JSON.stringify(unavailable), /private\/native/u);
});

test('a supported exact CMS mismatch makes the overall conclusion indeterminate', async (t) => {
  const { store, document } = await fixture(t);
  const poppler = {
    async execute(operation, parameters, options) {
      if (operation === 'dumpSignatures') {
        await writeFile(join(options.cwd, 'input.pdf.sig0'), dumpedCms);
        return { stdout: `Dumping Signatures: 1\nSignature #0 (4 bytes) => input.pdf.sig0\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: pdfsigOutput(parameters.input), stderr: '', exitCode: 0 };
    },
  };
  const result = await new OfflineSignatureService({
    store,
    poppler,
    trust: {
      async evaluate() {
        return nativeEvidence(document.sha256, {
          records: [{
            byteRange: [...signatureByteRange],
            subFilter: 'adbe.pkcs7.detached',
            cmsSha256: dumpedCmsSha256,
            certificateChain: {
              status: 'indeterminate', reason: 'cms-signature-mismatch', chainLength: null,
            },
          }],
        });
      },
    },
  }).verify(document.id);

  assert.equal(result.status, 'valid', 'Poppler-scoped evidence remains available');
  assert.equal(result.currentDocumentStatus, 'valid');
  assert.equal(result.overallCurrentDocumentStatus, 'indeterminate');
  assert.deepEqual(result.cmsCrossCheck, {
    status: 'indeterminate', verifiedCount: 0, indeterminateCount: 1,
    unsupportedCount: 0, reasons: ['cms-signature-mismatch'],
  });
});

test('helper fallback reasserts the staged copy and stored source before returning v1', async (t) => {
  async function poppler(operation, parameters, options) {
    if (operation === 'dumpSignatures') {
      await writeFile(join(options.cwd, 'input.pdf.sig0'), dumpedCms);
      return { stdout: 'Dumping Signatures: 1\nSignature #0 (4 bytes) => input.pdf.sig0\n', stderr: '', exitCode: 0 };
    }
    return { stdout: pdfsigOutput(parameters.input), stderr: '', exitCode: 0 };
  }

  await t.test('unchanged source permits an ordinary helper downgrade', async (subtest) => {
    const { store, document } = await fixture(subtest);
    const result = await new OfflineSignatureService({
      store,
      poppler: { execute: poppler },
      trust: { async evaluate() { throw new Error('ordinary helper failure'); } },
    }).verify(document.id);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.signatures[0].certificate, 'not-checked');
  });

  await t.test('staged-copy corruption propagates instead of downgrading', async (subtest) => {
    const { store, document } = await fixture(subtest);
    await assert.rejects(new OfflineSignatureService({
      store,
      poppler: { execute: poppler },
      trust: {
        async evaluate({ workspacePath }) {
          const input = join(workspacePath, 'input.pdf');
          const bytes = await readFile(input);
          bytes[0] ^= 1;
          await chmod(input, 0o600);
          await writeFile(input, bytes);
          await chmod(input, 0o400);
          throw new Error('ordinary helper failure after staged corruption');
        },
      },
    }).verify(document.id), /private source copy (?:identity )?changed/iu);
  });

  await t.test('stored-source corruption propagates instead of downgrading', async (subtest) => {
    const { store, document } = await fixture(subtest);
    const storedPath = store.getSourcePath(document.id);
    await assert.rejects(new OfflineSignatureService({
      store,
      poppler: { execute: poppler },
      trust: {
        async evaluate() {
          const bytes = await readFile(storedPath);
          bytes[0] ^= 1;
          await chmod(storedPath, 0o600);
          await writeFile(storedPath, bytes);
          await chmod(storedPath, 0o400);
          throw new Error('ordinary helper failure after source corruption');
        },
      },
    }).verify(document.id), { code: 'SOURCE_INTEGRITY_FAILED', status: 500 });
  });
});

test('enrichment integrity failures and cancellation never downgrade to v1', async (t) => {
  await t.test('signature dump failure propagates', async (subtest) => {
    const { store, document } = await fixture(subtest);
    await assert.rejects(new OfflineSignatureService({
      store,
      poppler: {
        async execute(operation, parameters) {
          if (operation === 'dumpSignatures') throw new Error('dump failed');
          return { stdout: pdfsigOutput(parameters.input), stderr: '', exitCode: 0 };
        },
      },
      trust: { async evaluate() { throw new Error('must not run'); } },
    }).verify(document.id), { code: 'SIGNATURE_DUMP_INVALID', status: 502 });
  });

  await t.test('helper cancellation propagates as job cancellation', async (subtest) => {
    const { store, document } = await fixture(subtest);
    await assert.rejects(new OfflineSignatureService({
      store,
      poppler: {
        async execute(operation, parameters, options) {
          if (operation === 'dumpSignatures') {
            await writeFile(join(options.cwd, 'input.pdf.sig0'), dumpedCms);
            return { stdout: 'Dumping Signatures: 1\nSignature #0 (4 bytes) => input.pdf.sig0\n', stderr: '', exitCode: 0 };
          }
          return { stdout: pdfsigOutput(parameters.input), stderr: '', exitCode: 0 };
        },
      },
      trust: {
        async evaluate() {
          throw Object.assign(new Error('cancelled'), { code: 'ENGINE_CANCELLED' });
        },
      },
    }).verify(document.id), { code: 'JOB_CANCELLED', status: 499 });
  });

  await t.test('helper source mismatch propagates', async (subtest) => {
    const { store, document } = await fixture(subtest);
    await assert.rejects(new OfflineSignatureService({
      store,
      poppler: {
        async execute(operation, parameters, options) {
          if (operation === 'dumpSignatures') {
            await writeFile(join(options.cwd, 'input.pdf.sig0'), dumpedCms);
            return { stdout: 'Dumping Signatures: 1\nSignature #0 (4 bytes) => input.pdf.sig0\n', stderr: '', exitCode: 0 };
          }
          return { stdout: pdfsigOutput(parameters.input), stderr: '', exitCode: 0 };
        },
      },
      trust: {
        async evaluate() {
          throw Object.assign(new Error('source mismatch'), {
            code: 'SIGNATURE_TRUST_SOURCE_MISMATCH',
          });
        },
      },
    }).verify(document.id), { code: 'SIGNATURE_TRUST_SOURCE_MISMATCH' });
  });
});
