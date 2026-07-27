import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import {
  executeOfflineSignatureInspection,
  mapSignatureInspectionError,
  MAX_JOB_WORKSPACE_BYTES,
} from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { dumpEmbeddedSignatures } from './signature-dump-service.mjs';

export const SIGNATURE_TRUST_LIMITS = Object.freeze({
  maxPdfBytes: 128 * 1024 * 1024,
  maxSignatures: 100,
  maxCmsBytesPerSignature: 1024 * 1024,
  maxCmsBytesTotal: 8 * 1024 * 1024,
  maxCertificatesPerSignature: 16,
  maxCertificateBytes: 64 * 1024,
  maxBerDepth: 32,
  maxBerNodes: 32 * 1024,
});

const EVIDENCE_MISMATCH = Object.freeze({
  status: 'indeterminate',
  reason: 'evidence-mismatch',
  chainLength: null,
});

const NON_DOWNGRADABLE_TRUST_ERRORS = new Set([
  'SIGNATURE_TRUST_INVALID_REQUEST',
  'SIGNATURE_TRUST_UNSAFE_WORKSPACE',
  'SIGNATURE_TRUST_SOURCE_MISMATCH',
  'SOURCE_INTEGRITY_FAILED',
]);

function rangeKey(byteRange) {
  return Array.isArray(byteRange) ? byteRange.join(':') : '';
}

function certificateChainSummary(signatures) {
  const statuses = signatures.map(({ certificateChain }) => certificateChain.status);
  if (statuses.every((status) => status === 'passes')) return 'all-pass';
  if (statuses.every((status) => status === 'fails')) return 'all-fail';
  if (statuses.some((status) => status === 'indeterminate')) return 'indeterminate';
  if (statuses.every((status) => status === 'unsupported')) return 'unsupported';
  return 'mixed';
}

function cmsCrossCheckSummary(signatures) {
  const verifiedCount = signatures.filter(({ certificateChain }) => (
    certificateChain.status === 'passes' || certificateChain.status === 'fails'
  )).length;
  const unresolved = signatures.filter(({ certificateChain }) => (
    certificateChain.status !== 'passes' && certificateChain.status !== 'fails'
  ));
  return Object.freeze({
    status: unresolved.length === 0 ? 'verified' : 'indeterminate',
    verifiedCount,
    indeterminateCount: unresolved.filter(({ certificateChain }) => certificateChain.status === 'indeterminate').length,
    unsupportedCount: unresolved.filter(({ certificateChain }) => certificateChain.status === 'unsupported').length,
    reasons: Object.freeze([...new Set(unresolved.map(({ certificateChain }) => certificateChain.reason))].sort()),
  });
}

function overallCurrentDocumentStatus(integrityEvidence, cmsCrossCheck) {
  if (integrityEvidence.status === 'invalid' || integrityEvidence.currentDocumentStatus === 'invalid') return 'invalid';
  if (integrityEvidence.status !== 'valid' || cmsCrossCheck.status !== 'verified') return 'indeterminate';
  return integrityEvidence.currentDocumentStatus === 'modified-after-signing'
    ? 'modified-after-signing'
    : integrityEvidence.currentDocumentStatus === 'valid' ? 'valid' : 'indeterminate';
}

export function mergeCertificateChainEvidence(integrityEvidence, nativeEvidence, dumpRecords) {
  if (!integrityEvidence || !Array.isArray(integrityEvidence.signatures)
    || integrityEvidence.signatures.length < 1 || !nativeEvidence
    || !Array.isArray(nativeEvidence.records) || !Array.isArray(dumpRecords)) {
    throw new TypeError('Integrity and native certificate evidence are required.');
  }
  const nativeByRange = new Map(nativeEvidence.records.map((record) => [rangeKey(record.byteRange), record]));
  const dumpByRange = new Map(dumpRecords.map((record) => [rangeKey(record.byteRange), record]));
  const exactMapping = nativeEvidence.sourceSha256 === integrityEvidence.sourceSha256
    && nativeEvidence.records.length === integrityEvidence.signatures.length
    && dumpRecords.length === integrityEvidence.signatures.length
    && nativeByRange.size === nativeEvidence.records.length
    && dumpByRange.size === dumpRecords.length
    && integrityEvidence.signatures.every((signature) => {
      const record = nativeByRange.get(rangeKey(signature.byteRange));
      const dump = dumpByRange.get(rangeKey(signature.byteRange));
      return record && dump && record.subFilter === signature.signatureType
        && dump.subFilter === signature.signatureType
        && record.cmsSha256 === dump.cmsSha256;
    });
  const signatures = integrityEvidence.signatures.map((signature) => {
    const record = exactMapping ? nativeByRange.get(rangeKey(signature.byteRange)) : null;
    const certificateChain = record?.certificateChain ?? EVIDENCE_MISMATCH;
    return Object.freeze({
      ...signature,
      certificate: certificateChain.status,
      certificateChain,
    });
  });
  const evaluation = Object.freeze({
    profile: nativeEvidence.profile,
    evaluatedAt: nativeEvidence.evaluatedAt,
    verificationTimeBasis: nativeEvidence.verificationTimeBasis,
    anchorBasis: nativeEvidence.anchorBasis,
    certificateNetworkFetchAllowed: nativeEvidence.certificateNetworkFetchAllowed,
  });
  const cmsCrossCheck = cmsCrossCheckSummary(signatures);
  return Object.freeze({
    ...integrityEvidence,
    schemaVersion: 2,
    popplerEvidence: Object.freeze({
      engine: 'Poppler pdfsig',
      integrityStatus: integrityEvidence.status,
      currentDocumentStatus: integrityEvidence.currentDocumentStatus,
    }),
    cmsCrossCheck,
    overallCurrentDocumentStatus: overallCurrentDocumentStatus(integrityEvidence, cmsCrossCheck),
    certificateChainSummary: certificateChainSummary(signatures),
    certificateEvaluation: evaluation,
    signatures: Object.freeze(signatures),
    limitations: Object.freeze([
      `Embedded certificate paths were evaluated against this Mac's current trust configuration at ${evaluation.evaluatedAt}; certificate fetching was disabled.`,
      'Basic X.509 path evaluation does not verify signer identity, PDF-signing key usage, validity at signing time, or trust on another system.',
      'Revocation, OCSP, CRL, LTV, trusted timestamps, certification permissions, and legal effect were not checked.',
      'Signer names and signing times remain unverified claims embedded in the PDF.',
      'Certificate paths are evaluated only after the exact Poppler-dumped CMS verifies against its declared signed byte ranges.',
    ]),
  });
}

function signatureTrustRequest(sourceSha256, records) {
  return Object.freeze({
    version: 1,
    operation: 'validateEmbeddedCertificateChains',
    inputFilename: 'input.pdf',
    sourceSha256,
    limits: SIGNATURE_TRUST_LIMITS,
    records,
  });
}

export class OfflineSignatureService {
  #store;
  #poppler;
  #trust;

  constructor({ store, poppler, trust = null } = {}) {
    if (!store
      || !poppler
      || (trust !== null && typeof trust.evaluate !== 'function')) {
      throw new TypeError('OfflineSignatureService requires a document store, Poppler adapter, and optional trust adapter.');
    }
    this.#store = store;
    this.#poppler = poppler;
    this.#trust = trust;
  }

  async verify(documentId, { signal } = {}) {
    const source = this.#store.getDocument(documentId);
    const storedSourcePath = this.#store.getSourcePath(documentId);
    const workspace = await this.#store.createJobWorkspace(documentId);
    const input = join(workspace, 'input.pdf');
    const nssDirectory = join(workspace, 'nss');
    const dumpDirectory = join(workspace, 'dumps');
    const requestPath = join(workspace, 'request.json');
    try {
      await this.#store.verifySource(documentId);
      let identity;
      try {
        identity = await stagePrivateSourceCopy({
          sourcePath: storedSourcePath,
          targetPath: input,
          expectedSha256: source.sha256,
          expectedSize: source.size,
          maximumBytes: MAX_JOB_WORKSPACE_BYTES,
        });
      } catch (error) {
        throw new HostError(
          'SIGNATURE_SOURCE_BINDING_FAILED',
          'Signature inspection could not bind a private immutable source copy.',
          500,
          { cause: error },
        );
      }
      await mkdir(nssDirectory, { mode: 0o700 });
      const parsed = await executeOfflineSignatureInspection(this.#poppler, {
        input,
        nssDirectory,
        signal,
      });
      await assertPrivateSourceCopy({
        path: input,
        identity,
        expectedSha256: source.sha256,
        expectedSize: source.size,
        maximumBytes: MAX_JOB_WORKSPACE_BYTES,
      });
      await this.#store.verifySource(documentId);
      const integrityEvidence = Object.freeze({ sourceSha256: source.sha256, ...parsed });
      if (!this.#trust || parsed.status !== 'valid' || source.size > SIGNATURE_TRUST_LIMITS.maxPdfBytes) {
        return integrityEvidence;
      }
      await mkdir(dumpDirectory, { mode: 0o700 });
      const dumpRecords = await dumpEmbeddedSignatures(this.#poppler, {
        input,
        nssDirectory,
        dumpDirectory,
        signatures: integrityEvidence.signatures,
        signal,
        timeoutMs: 30_000,
      });
      await assertPrivateSourceCopy({
        path: input,
        identity,
        expectedSha256: source.sha256,
        expectedSize: source.size,
        maximumBytes: MAX_JOB_WORKSPACE_BYTES,
      });
      const request = Buffer.from(JSON.stringify(signatureTrustRequest(source.sha256, dumpRecords)), 'utf8');
      await writeFile(requestPath, request, { flag: 'wx', mode: 0o400 });
      let nativeEvidence;
      try {
        nativeEvidence = await this.#trust.evaluate(
          { workspacePath: workspace, requestPath },
          { signal, timeoutMs: 30_000 },
        );
      } catch (error) {
        if (error?.code === 'ENGINE_CANCELLED'
          || NON_DOWNGRADABLE_TRUST_ERRORS.has(error?.code)) throw error;
        await assertPrivateSourceCopy({
          path: input,
          identity,
          expectedSha256: source.sha256,
          expectedSize: source.size,
          maximumBytes: MAX_JOB_WORKSPACE_BYTES,
        });
        await this.#store.verifySource(documentId);
        return integrityEvidence;
      }
      await assertPrivateSourceCopy({
        path: input,
        identity,
        expectedSha256: source.sha256,
        expectedSize: source.size,
        maximumBytes: MAX_JOB_WORKSPACE_BYTES,
      });
      await this.#store.verifySource(documentId);
      return mergeCertificateChainEvidence(integrityEvidence, nativeEvidence, dumpRecords);
    } catch (error) {
      throw mapSignatureInspectionError(error);
    } finally {
      await this.#store.cleanupJob(workspace);
    }
  }
}
