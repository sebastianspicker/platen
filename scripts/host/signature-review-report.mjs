import { createHash } from 'node:crypto';
import { HostError } from './host-error.mjs';
import {
  MAX_SIGNATURE_REVIEW_SIGNATURES,
  SIGNATURE_HASH_ALGORITHM,
  SIGNATURE_PATH_STATUSES,
  SIGNATURE_TYPE_TOKEN,
  canonicalSignatureTime,
  derivedCombinedCurrentStatus,
  derivedCurrentDocumentStatus,
  derivedSignatureCoverage,
  derivedSignatureIntegrity,
  exactSignatureObject,
  safeSignatureToken,
  signaturePathSummary,
  snapshotSignatureJson,
  validateSignatureEvidence,
} from './signature-review-validation.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const issuedReports = new WeakSet();

export const SIGNATURE_REVIEW_LIMITATIONS = Object.freeze([
  'The report is a local offline review of embedded-signature evidence; it does not mutate the PDF.',
  'Certificate-path status, when present, is Basic X.509 evidence against the current Mac trust configuration at the stated host-current time with certificate fetching disabled.',
  'It does not claim deterministic PDF bytes, LTV, revocation, OCSP, CRL, trusted timestamps, or full certificate validation.',
  'It does not verify signer identity, PDF-signing key usage, validity at signing time, certification permissions, legal effect, or trust on another system.',
]);

function fail(message, code = 'SIGNATURE_REVIEW_INVALID') {
  throw new HostError(code, message, 502);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function projectedSignatures(evidence) {
  return Object.freeze(evidence.signatures.map((signature) => Object.freeze({
    index: signature.index,
    integrity: signature.integrity,
    documentCoverage: signature.documentCoverage,
    hashAlgorithm: signature.hashAlgorithm,
    signatureType: signature.signatureType,
    certificatePathStatus: evidence.schemaVersion === 2
      ? signature.certificateChain.status : 'not-checked',
  })));
}

function reportCrossCheck(signatures) {
  const statuses = signatures.map(({ certificatePathStatus }) => certificatePathStatus);
  const verifiedCount = statuses.filter((status) => status === 'passes' || status === 'fails').length;
  const indeterminateCount = statuses.filter((status) => status === 'indeterminate').length;
  const unsupportedCount = statuses.filter((status) => status === 'unsupported').length;
  return Object.freeze({
    status: indeterminateCount + unsupportedCount === 0 ? 'verified' : 'indeterminate',
    verifiedCount, indeterminateCount, unsupportedCount,
  });
}

function projectedPathEvaluation(evidence, signatures) {
  if (evidence.schemaVersion === 1) return Object.freeze({
    performed: false,
    profile: null,
    evaluatedAt: null,
    verificationTimeBasis: null,
    anchorBasis: null,
    certificateNetworkFetchAllowed: null,
    exactCmsCrossCheck: null,
    summary: 'not-checked',
  });
  return Object.freeze({
    performed: true,
    profile: evidence.certificateEvaluation.profile,
    evaluatedAt: evidence.certificateEvaluation.evaluatedAt,
    verificationTimeBasis: evidence.certificateEvaluation.verificationTimeBasis,
    anchorBasis: evidence.certificateEvaluation.anchorBasis,
    certificateNetworkFetchAllowed: false,
    exactCmsCrossCheck: reportCrossCheck(signatures),
    summary: signaturePathSummary(
      signatures.map(({ certificatePathStatus }) => certificatePathStatus),
    ),
  });
}

/** Creates the fixed no-raw, no-path projection for CLI publication. */
export function serializeSignatureReview(evidence, { evaluatedAt = new Date().toISOString() } = {}) {
  const value = snapshotSignatureJson(evidence, {
    label: 'Signature evidence', maxBytes: MAX_EVIDENCE_BYTES,
  });
  validateSignatureEvidence(value);
  canonicalSignatureTime(evaluatedAt, 'Review evaluation time');
  const signatures = projectedSignatures(value);
  const pathEvaluation = projectedPathEvaluation(value, signatures);
  if (pathEvaluation.evaluatedAt !== null
    && Date.parse(evaluatedAt) < Date.parse(pathEvaluation.evaluatedAt)) {
    fail('Review evaluation time cannot precede certificate-path evaluation.');
  }
  const reviewed = Object.freeze({
    kind: 'offline-signature-review',
    schemaVersion: 2,
    profile: 'offline-embedded-signature-review-v2',
    sourceDigest: value.sourceSha256,
    evaluatedAt,
    evidenceSchemaVersion: value.schemaVersion,
    integrity: Object.freeze({
      status: value.status,
      currentDocumentStatus: value.currentDocumentStatus,
      coverageStatus: value.coverageStatus,
      signatureCount: value.signatureCount,
      combinedCurrentDocumentStatus: value.schemaVersion === 2
        ? value.overallCurrentDocumentStatus : null,
    }),
    certificatePathEvaluation: pathEvaluation,
    signatures,
    limitations: SIGNATURE_REVIEW_LIMITATIONS,
  });
  const report = Object.freeze({ ...reviewed, reportSha256: digest(reviewed) });
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES) {
    fail('The signature review exceeds its report-size limit.');
  }
  issuedReports.add(report);
  return report;
}

function validateReportSignature(signature, index) {
  exactSignatureObject(signature, [
    'index', 'integrity', 'documentCoverage', 'hashAlgorithm', 'signatureType',
    'certificatePathStatus',
  ], 'Signature review record');
  safeSignatureToken(signature.hashAlgorithm, SIGNATURE_HASH_ALGORITHM, 'Signature hash algorithm');
  safeSignatureToken(signature.signatureType, SIGNATURE_TYPE_TOKEN, 'Signature type');
  if (signature.index !== index + 1
    || !['valid', 'invalid', 'indeterminate'].includes(signature.integrity)
    || !['full', 'prior-revision'].includes(signature.documentCoverage)
    || !['not-checked', ...SIGNATURE_PATH_STATUSES].includes(signature.certificatePathStatus)) {
    fail('Signature review record is invalid.');
  }
}

function validatePathEvaluation(report) {
  const evaluation = report.certificatePathEvaluation;
  exactSignatureObject(evaluation, [
    'performed', 'profile', 'evaluatedAt', 'verificationTimeBasis', 'anchorBasis',
    'certificateNetworkFetchAllowed', 'exactCmsCrossCheck', 'summary',
  ], 'Certificate-path review');
  if (report.evidenceSchemaVersion === 1) {
    if (evaluation.performed !== false || evaluation.profile !== null
      || evaluation.evaluatedAt !== null || evaluation.verificationTimeBasis !== null
      || evaluation.anchorBasis !== null || evaluation.certificateNetworkFetchAllowed !== null
      || evaluation.exactCmsCrossCheck !== null || evaluation.summary !== 'not-checked'
      || report.signatures.some(({ certificatePathStatus }) => certificatePathStatus !== 'not-checked')
      || report.integrity.combinedCurrentDocumentStatus !== null) {
      fail('Version 1 evidence must not claim certificate-path evaluation.');
    }
    return;
  }
  canonicalSignatureTime(evaluation.evaluatedAt, 'Certificate-path evaluation time');
  if (evaluation.performed !== true
    || evaluation.profile !== 'macos-basic-x509-current-trust-v2'
    || evaluation.verificationTimeBasis !== 'host-current-time'
    || evaluation.anchorBasis !== 'current-macos-trust-configuration'
    || evaluation.certificateNetworkFetchAllowed !== false
    || Date.parse(report.evaluatedAt) < Date.parse(evaluation.evaluatedAt)
    || report.signatures.some(({ certificatePathStatus }) => certificatePathStatus === 'not-checked')) {
    fail('Version 2 certificate-path scope is invalid.');
  }
  exactSignatureObject(evaluation.exactCmsCrossCheck, [
    'status', 'verifiedCount', 'indeterminateCount', 'unsupportedCount',
  ], 'Exact CMS review');
  const expectedCrossCheck = reportCrossCheck(report.signatures);
  for (const key of Object.keys(expectedCrossCheck)) {
    if (evaluation.exactCmsCrossCheck[key] !== expectedCrossCheck[key]) {
      fail('Exact CMS review counts are inconsistent.');
    }
  }
  const expectedSummary = signaturePathSummary(
    report.signatures.map(({ certificatePathStatus }) => certificatePathStatus),
  );
  if (evaluation.summary !== expectedSummary
    || report.integrity.combinedCurrentDocumentStatus !== derivedCombinedCurrentStatus(
      report.integrity.status,
      report.integrity.currentDocumentStatus,
      expectedCrossCheck.status,
    )) fail('Certificate-path review conclusions are inconsistent.');
}

export function validateSignatureReviewReport(
  report,
  { expectedSourceDigest, requireTrustedIssue = true } = {},
) {
  const value = snapshotSignatureJson(report, {
    label: 'Signature review', maxBytes: MAX_REPORT_BYTES,
  });
  exactSignatureObject(value, [
    'kind', 'schemaVersion', 'profile', 'sourceDigest', 'evaluatedAt',
    'evidenceSchemaVersion', 'integrity', 'certificatePathEvaluation',
    'signatures', 'limitations', 'reportSha256',
  ], 'Signature review');
  exactSignatureObject(value.integrity, [
    'status', 'currentDocumentStatus', 'coverageStatus', 'signatureCount',
    'combinedCurrentDocumentStatus',
  ], 'Signature review integrity');
  if (value.kind !== 'offline-signature-review' || value.schemaVersion !== 2
    || value.profile !== 'offline-embedded-signature-review-v2'
    || !SHA256.test(value.sourceDigest) || value.sourceDigest !== expectedSourceDigest
    || ![1, 2].includes(value.evidenceSchemaVersion) || !SHA256.test(value.reportSha256)
    || !Array.isArray(value.signatures)
    || value.signatures.length > MAX_SIGNATURE_REVIEW_SIGNATURES) {
    fail('Signature review identity or source binding is invalid.');
  }
  canonicalSignatureTime(value.evaluatedAt, 'Review evaluation time');
  value.signatures.forEach(validateReportSignature);
  const status = derivedSignatureIntegrity(value.signatures);
  const coverage = derivedSignatureCoverage(value.signatures);
  const current = derivedCurrentDocumentStatus(status, coverage);
  if (value.integrity.status !== status || value.integrity.coverageStatus !== coverage
    || value.integrity.currentDocumentStatus !== current
    || value.integrity.signatureCount !== value.signatures.length
    || (value.evidenceSchemaVersion === 2 && (status !== 'valid' || !value.signatures.length))) {
    fail('Signature review integrity fields are inconsistent.');
  }
  validatePathEvaluation(value);
  if (!Array.isArray(value.limitations)
    || value.limitations.length !== SIGNATURE_REVIEW_LIMITATIONS.length
    || value.limitations.some((item, index) => item !== SIGNATURE_REVIEW_LIMITATIONS[index])) {
    fail('Signature review limitations do not match the fixed boundary.');
  }
  const { reportSha256, ...unsigned } = value;
  if (digest(unsigned) !== reportSha256) {
    fail('Signature review digest verification failed.', 'SIGNATURE_REVIEW_INTEGRITY_FAILED');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REPORT_BYTES) {
    fail('The signature review exceeds its report-size limit.');
  }
  if (typeof requireTrustedIssue !== 'boolean'
    || (requireTrustedIssue && !issuedReports.has(report))) {
    fail('Signature review publication requires an exact host-issued report.');
  }
  return requireTrustedIssue ? report : Object.freeze(value);
}
