import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export const SIGNATURE_HASH_ALGORITHM = /^[A-Za-z0-9-]{1,64}$/u;
export const SIGNATURE_TYPE_TOKEN = /^[A-Za-z0-9._-]{1,128}$/u;
export const MAX_SIGNATURE_REVIEW_SIGNATURES = 100;
export const SIGNATURE_PATH_STATUSES = Object.freeze([
  'passes', 'fails', 'indeterminate', 'unsupported',
]);
const CHAIN_REASONS = Object.freeze([
  'none', 'expired', 'not-yet-valid', 'not-trusted', 'explicitly-denied',
  'policy-failure', 'malformed-cms', 'missing-embedded-signer-certificate',
  'multiple-cms-signers', 'unsupported-subfilter', 'cms-signature-mismatch',
  'resource-limit', 'platform-error',
]);
const V1_LIMITATIONS = Object.freeze([
  'Certificate trust was not checked.',
  'Revocation, LTV, and trusted timestamps were not checked.',
  'Signer fields are claims embedded in the PDF, not verified identity.',
]);

function fail(message) {
  throw new HostError('SIGNATURE_REVIEW_INVALID', message, 502);
}

export function canonicalSignatureTime(value, label) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)
    || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical UTC millisecond timestamp.`);
  }
}

export function exactSignatureObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} must contain the fixed fields.`);
  }
}

function snapshotNode(value, state, depth) {
  state.items += 1;
  if (state.items > 4_000 || depth > 12) fail(`${state.label} exceeds structural limits.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${state.label} contains a non-finite number.`);
    return value;
  }
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value);
    state.bytes += bytes;
    if (bytes > 16 * 1024 || state.bytes > state.maxBytes) fail(`${state.label} contains oversized text.`);
    return value;
  }
  if (!value || typeof value !== 'object' || isProxy(value) || state.active.has(value)) {
    fail(`${state.label} must be acyclic plain JSON data.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    fail(`${state.label} contains an exotic object.`);
  }
  state.active.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  let copied;
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    if (prototype !== Array.prototype || !Number.isSafeInteger(length)
      || length < 0 || length > MAX_SIGNATURE_REVIEW_SIGNATURES) {
      fail(`${state.label} contains an invalid array.`);
    }
    const expected = Array.from({ length }, (_, index) => String(index));
    const actual = keys.filter((key) => key !== 'length');
    if (actual.length !== expected.length || actual.some((key) => typeof key !== 'string')
      || expected.some((key) => !Object.hasOwn(descriptors, key)
        || !('value' in descriptors[key]) || !descriptors[key].enumerable)) {
      fail(`${state.label} requires dense data-only arrays.`);
    }
    copied = expected.map((key) => snapshotNode(descriptors[key].value, state, depth + 1));
  } else {
    if (prototype === Array.prototype || keys.some((key) => typeof key !== 'string'
      || key === 'toJSON' || !('value' in descriptors[key]) || !descriptors[key].enumerable)) {
      fail(`${state.label} requires plain enumerable data properties without JSON hooks.`);
    }
    copied = Object.create(null);
    for (const key of keys) copied[key] = snapshotNode(descriptors[key].value, state, depth + 1);
  }
  state.active.delete(value);
  return copied;
}

export function snapshotSignatureJson(value, { label, maxBytes }) {
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) {
    fail(`${label} rejects inherited JSON hooks.`);
  }
  return snapshotNode(value, {
    active: new Set(), items: 0, bytes: 0, label, maxBytes,
  }, 0);
}

function boundedClaim(value, label) {
  if (value !== null && (typeof value !== 'string' || value.length > 4_096
    || Buffer.byteLength(value) > 16 * 1024)) fail(`${label} is invalid.`);
}

export function safeSignatureToken(value, pattern, label) {
  if (value !== null && (typeof value !== 'string' || !pattern.test(value))) {
    fail(`${label} is invalid.`);
  }
}

function validByteRange(value) {
  if (!Array.isArray(value) || value.length !== 4
    || value.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) return false;
  const [firstOffset, firstLength, secondOffset, secondLength] = value;
  return firstOffset === 0 && firstLength > 0 && secondOffset > firstLength
    && secondLength > 0 && secondOffset + secondLength <= Number.MAX_SAFE_INTEGER;
}

export function derivedSignatureIntegrity(signatures) {
  if (signatures.length === 0) return 'unsigned';
  if (signatures.some(({ integrity }) => integrity === 'invalid')) return 'invalid';
  if (signatures.some(({ integrity }) => integrity === 'indeterminate')) return 'indeterminate';
  return 'valid';
}

export function derivedSignatureCoverage(signatures) {
  if (signatures.length === 0) return 'unsigned';
  if (signatures.every(({ documentCoverage }) => documentCoverage === 'full')) return 'full';
  if (signatures.every(({ documentCoverage }) => documentCoverage === 'prior-revision')) {
    return 'prior-revision';
  }
  return 'mixed';
}

export function derivedCurrentDocumentStatus(status, coverage) {
  if (status === 'unsigned' || status === 'invalid' || status === 'indeterminate') return status;
  return coverage === 'full' ? 'valid' : 'modified-after-signing';
}

function expectedSummary(status, count) {
  return status === 'unsigned'
    ? 'No embedded signatures'
    : `${count} embedded signature${count === 1 ? '' : 's'} · ${status} integrity evidence`;
}

function validateBaseSignature(signature, index, enriched) {
  exactSignatureObject(signature, [
    'index', 'claimedSigner', 'claimedSigningTime', 'hashAlgorithm', 'signatureType',
    'byteRange', 'documentCoverage', 'integrity', 'certificate', 'revocation',
    'timestamp', 'identityVerified', ...(enriched ? ['certificateChain'] : []),
  ], 'Signature evidence record');
  exactSignatureObject(signature.claimedSigner, ['commonName', 'distinguishedName'], 'Claimed signer');
  boundedClaim(signature.claimedSigner.commonName, 'Claimed signer common name');
  boundedClaim(signature.claimedSigner.distinguishedName, 'Claimed signer distinguished name');
  boundedClaim(signature.claimedSigningTime, 'Claimed signing time');
  safeSignatureToken(signature.hashAlgorithm, SIGNATURE_HASH_ALGORITHM, 'Signature hash algorithm');
  safeSignatureToken(signature.signatureType, SIGNATURE_TYPE_TOKEN, 'Signature type');
  if (signature.index !== index + 1 || !validByteRange(signature.byteRange)
    || !['full', 'prior-revision'].includes(signature.documentCoverage)
    || !['valid', 'invalid', 'indeterminate'].includes(signature.integrity)
    || signature.revocation !== 'not-checked' || signature.timestamp !== 'not-checked'
    || signature.identityVerified !== false) fail('Signature evidence record is inconsistent.');
}

function validatePathChain(chain) {
  exactSignatureObject(chain, ['status', 'reason', 'chainLength'], 'Certificate-path evidence');
  if (!SIGNATURE_PATH_STATUSES.includes(chain.status) || !CHAIN_REASONS.includes(chain.reason)) {
    fail('Certificate-path evidence is invalid.');
  }
  const boundedLength = Number.isSafeInteger(chain.chainLength)
    && chain.chainLength >= 1 && chain.chainLength <= 16;
  if ((chain.status === 'passes' && (chain.reason !== 'none' || !boundedLength))
    || (chain.status === 'fails' && (chain.reason === 'none' || !boundedLength))
    || (chain.status === 'unsupported'
      && (chain.reason !== 'unsupported-subfilter' || chain.chainLength !== null))
    || (chain.status === 'indeterminate'
      && (chain.reason === 'none' || chain.chainLength !== null))) {
    fail('Certificate-path status, reason, and length are inconsistent.');
  }
}

export function signaturePathSummary(statuses) {
  if (statuses.every((status) => status === 'passes')) return 'all-pass';
  if (statuses.every((status) => status === 'fails')) return 'all-fail';
  if (statuses.some((status) => status === 'indeterminate')) return 'indeterminate';
  if (statuses.every((status) => status === 'unsupported')) return 'unsupported';
  return 'mixed';
}

function exactCrossCheck(signatures) {
  const verifiedCount = signatures.filter(({ certificateChain }) => (
    certificateChain.status === 'passes' || certificateChain.status === 'fails'
  )).length;
  const indeterminateCount = signatures.filter(({ certificateChain }) => (
    certificateChain.status === 'indeterminate'
  )).length;
  const unsupportedCount = signatures.filter(({ certificateChain }) => (
    certificateChain.status === 'unsupported'
  )).length;
  const reasons = [...new Set(signatures
    .filter(({ certificateChain }) => ['indeterminate', 'unsupported'].includes(certificateChain.status))
    .map(({ certificateChain }) => certificateChain.reason))].sort();
  return Object.freeze({
    status: indeterminateCount + unsupportedCount === 0 ? 'verified' : 'indeterminate',
    verifiedCount, indeterminateCount, unsupportedCount, reasons: Object.freeze(reasons),
  });
}

export function derivedCombinedCurrentStatus(status, currentDocumentStatus, crossCheckStatus) {
  if (status === 'invalid' || currentDocumentStatus === 'invalid') return 'invalid';
  if (status !== 'valid' || crossCheckStatus !== 'verified') return 'indeterminate';
  if (currentDocumentStatus === 'modified-after-signing') return 'modified-after-signing';
  return currentDocumentStatus === 'valid' ? 'valid' : 'indeterminate';
}

function validateEnrichedEvidence(evidence) {
  if (evidence.status !== 'valid' || evidence.signatures.length < 1) {
    fail('Enriched evidence requires valid non-empty Poppler evidence.');
  }
  exactSignatureObject(
    evidence.popplerEvidence,
    ['engine', 'integrityStatus', 'currentDocumentStatus'],
    'Poppler evidence',
  );
  if (evidence.popplerEvidence.engine !== 'Poppler pdfsig'
    || evidence.popplerEvidence.integrityStatus !== evidence.status
    || evidence.popplerEvidence.currentDocumentStatus !== evidence.currentDocumentStatus) {
    fail('Poppler evidence scope is inconsistent.');
  }
  exactSignatureObject(evidence.cmsCrossCheck, [
    'status', 'verifiedCount', 'indeterminateCount', 'unsupportedCount', 'reasons',
  ], 'Exact CMS cross-check');
  const crossCheck = exactCrossCheck(evidence.signatures);
  if (evidence.cmsCrossCheck.status !== crossCheck.status
    || evidence.cmsCrossCheck.verifiedCount !== crossCheck.verifiedCount
    || evidence.cmsCrossCheck.indeterminateCount !== crossCheck.indeterminateCount
    || evidence.cmsCrossCheck.unsupportedCount !== crossCheck.unsupportedCount
    || !Array.isArray(evidence.cmsCrossCheck.reasons)
    || evidence.cmsCrossCheck.reasons.length !== crossCheck.reasons.length
    || evidence.cmsCrossCheck.reasons.some((reason, index) => reason !== crossCheck.reasons[index])) {
    fail('Exact CMS cross-check counts or reasons are inconsistent.');
  }
  const statuses = evidence.signatures.map(({ certificateChain }) => certificateChain.status);
  if (evidence.certificateChainSummary !== signaturePathSummary(statuses)
    || evidence.overallCurrentDocumentStatus !== derivedCombinedCurrentStatus(
      evidence.status, evidence.currentDocumentStatus, crossCheck.status,
    )) fail('Enriched signature conclusions are inconsistent.');
  exactSignatureObject(evidence.certificateEvaluation, [
    'profile', 'evaluatedAt', 'verificationTimeBasis', 'anchorBasis',
    'certificateNetworkFetchAllowed',
  ], 'Certificate-path evaluation');
  canonicalSignatureTime(evidence.certificateEvaluation.evaluatedAt, 'Certificate-path evaluation time');
  if (evidence.certificateEvaluation.profile !== 'macos-basic-x509-current-trust-v2'
    || evidence.certificateEvaluation.verificationTimeBasis !== 'host-current-time'
    || evidence.certificateEvaluation.anchorBasis !== 'current-macos-trust-configuration'
    || evidence.certificateEvaluation.certificateNetworkFetchAllowed !== false) {
    fail('Certificate-path evaluation scope is invalid.');
  }
  const expectedLimitations = [
    `Embedded certificate paths were evaluated against this Mac's current trust configuration at ${evidence.certificateEvaluation.evaluatedAt}; certificate fetching was disabled.`,
    'Basic X.509 path evaluation does not verify signer identity, PDF-signing key usage, validity at signing time, or trust on another system.',
    'Revocation, OCSP, CRL, LTV, trusted timestamps, certification permissions, and legal effect were not checked.',
    'Signer names and signing times remain unverified claims embedded in the PDF.',
    'Certificate paths are evaluated only after the exact Poppler-dumped CMS verifies against its declared signed byte ranges.',
  ];
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== expectedLimitations.length
    || evidence.limitations.some((item, index) => item !== expectedLimitations[index])) {
    fail('Enriched signature limitations are invalid.');
  }
}

export function validateSignatureEvidence(evidence) {
  const v1Keys = [
    'sourceSha256', 'schemaVersion', 'profile', 'status', 'integrityStatus',
    'coverageStatus', 'currentDocumentStatus', 'count', 'signatureCount',
    'summary', 'signatures', 'limitations',
  ];
  const v2Keys = [
    ...v1Keys, 'popplerEvidence', 'cmsCrossCheck', 'overallCurrentDocumentStatus',
    'certificateChainSummary', 'certificateEvaluation',
  ];
  if (![1, 2].includes(evidence.schemaVersion)) fail('Signature evidence schema version is unsupported.');
  exactSignatureObject(evidence, evidence.schemaVersion === 1 ? v1Keys : v2Keys, 'Signature evidence');
  if (!SHA256.test(evidence.sourceSha256) || evidence.profile !== 'poppler-offline-integrity-v1'
    || !Array.isArray(evidence.signatures)
    || evidence.signatures.length > MAX_SIGNATURE_REVIEW_SIGNATURES) {
    fail('Signature evidence identity is invalid.');
  }
  evidence.signatures.forEach((signature, index) => {
    validateBaseSignature(signature, index, evidence.schemaVersion === 2);
    if (evidence.schemaVersion === 1 && signature.certificate !== 'not-checked') {
      fail('Version 1 evidence must not claim certificate-path evaluation.');
    }
    if (evidence.schemaVersion === 2) {
      validatePathChain(signature.certificateChain);
      if (signature.certificate !== signature.certificateChain.status) {
        fail('Certificate-path status does not match its record.');
      }
    }
  });
  const status = derivedSignatureIntegrity(evidence.signatures);
  const coverage = derivedSignatureCoverage(evidence.signatures);
  const current = derivedCurrentDocumentStatus(status, coverage);
  if (evidence.status !== status || evidence.integrityStatus !== status
    || evidence.coverageStatus !== coverage || evidence.currentDocumentStatus !== current
    || evidence.count !== evidence.signatures.length
    || evidence.signatureCount !== evidence.signatures.length
    || evidence.summary !== expectedSummary(status, evidence.signatures.length)) {
    fail('Signature evidence summary fields are inconsistent.');
  }
  if (evidence.schemaVersion === 1) {
    if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== V1_LIMITATIONS.length
      || evidence.limitations.some((item, index) => item !== V1_LIMITATIONS[index])) {
      fail('Version 1 signature limitations are invalid.');
    }
    return;
  }
  validateEnrichedEvidence(evidence);
}
