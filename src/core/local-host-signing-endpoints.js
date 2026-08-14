import { isProxy } from 'node:util/types';
import { normalizeCertificateSignatureRequest } from './pdf-certificate-signature-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
const SHA256 = /^[0-9a-f]{64}$/u;
const HASH_ALGORITHM = /^[A-Za-z0-9-]{1,64}$/u;
const SIGNATURE_TYPE = /^[A-Za-z0-9._-]{1,128}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SIGNATURE_STATUSES = Object.freeze(['unsigned', 'valid', 'invalid', 'indeterminate']);
const CURRENT_DOCUMENT_STATUSES = Object.freeze(['unsigned', 'valid', 'invalid', 'indeterminate', 'modified-after-signing']);
const CERTIFICATE_STATUSES = Object.freeze(['not-checked', 'passes', 'fails', 'indeterminate', 'unsupported']);
const CERTIFICATE_PATH_STATUSES = Object.freeze(['passes', 'fails', 'indeterminate', 'unsupported']);
const CHAIN_REASONS = Object.freeze([
  'none', 'expired', 'not-yet-valid', 'not-trusted', 'explicitly-denied',
  'policy-failure', 'malformed-cms', 'missing-embedded-signer-certificate',
  'multiple-cms-signers', 'unsupported-subfilter', 'cms-signature-mismatch',
  'resource-limit', 'platform-error', 'evidence-mismatch',
]);
const ELECTRONIC_INTENT_PROFILE = 'local-electronic-signing-intent-v1';
const ELECTRONIC_RESULT_KEYS = Object.freeze([
  'kind', 'profile', 'documentId', 'sourceSha256', 'workspaceRevision', 'recordId',
  'signerSha256', 'intentSha256', 'consentRecorded', 'localOnly',
  'certificateSignature', 'identityVerified', 'timestampTrusted',
  'legalEffectDetermined', 'limitations',
]);
const MAX_SIGNATURES = 100;
const MAX_TEXT_BYTES = 16 * 1024;
const textBytes = (value) => new TextEncoder().encode(value).byteLength;

function invalid(message) {
  throw new TypeError(`Signature evidence is invalid: ${message}`);
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must contain the fixed fields.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid(`${label} must contain the fixed fields.`);
  if (actual.some((key) => !keys.includes(key))) invalid(`${label} contains unsupported fields.`);
  return value;
}

function unsafeText(value) {
  return /[\u0000-\u001f\u007f]/u.test(value)
    || value.startsWith('/') || value.includes('\\') || /^file:/iu.test(value)
    || /(?:^|[/\\])(?:private|tmp|var|users|home)(?:[/\\]|$)/iu.test(value)
    || /(?:^|[/\\])\.\.?(?:[/\\]|$)/u.test(value);
}

function boundedText(value, label, { nullable = false, nonEmpty = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)
    || value.length > 4_096 || textBytes(value) > MAX_TEXT_BYTES || unsafeText(value)) invalid(`${label} is invalid.`);
}

function safeToken(value, pattern, label) {
  if (value !== null && (typeof value !== 'string' || !pattern.test(value))) invalid(`${label} is invalid.`);
}

function snapshot(value, state, depth = 0) {
  state.items += 1;
  if (state.items > 4_000 || depth > 12) invalid('evidence exceeds structural limits.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('evidence contains a non-finite number.');
    return value;
  }
  if (typeof value === 'string') {
    state.bytes += textBytes(value);
    if (state.bytes > 2 * 1024 * 1024) invalid('evidence contains oversized text.');
    return value;
  }
  if (!value || typeof value !== 'object' || isProxy(value) || state.active.has(value)) invalid('evidence must be acyclic plain JSON data.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) invalid('evidence contains an exotic object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  state.active.add(value);
  let copied;
  if (Array.isArray(value)) {
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (prototype !== Array.prototype || !lengthDescriptor || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(length) || length < 0 || length > MAX_SIGNATURES) invalid('evidence contains an invalid array.');
    const expected = Array.from({ length }, (_, index) => String(index));
    const actual = keys.filter((key) => key !== 'length');
    if (actual.length !== expected.length || actual.some((key) => typeof key !== 'string')
      || expected.some((key) => !Object.hasOwn(descriptors, key)
        || !('value' in descriptors[key]) || !descriptors[key].enumerable)) invalid('evidence requires dense data-only arrays.');
    copied = expected.map((key) => snapshot(descriptors[key].value, state, depth + 1));
  } else {
    if (prototype === Array.prototype || keys.some((key) => typeof key !== 'string'
      || !('value' in descriptors[key]) || !descriptors[key].enumerable)) invalid('evidence requires plain enumerable data properties.');
    copied = {};
    for (const key of keys) Object.defineProperty(copied, key, {
      value: snapshot(descriptors[key].value, state, depth + 1),
      enumerable: true, writable: true, configurable: true,
    });
  }
  state.active.delete(value);
  return copied;
}

function snapshotEvidence(value) {
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) invalid('inherited JSON hooks are not allowed.');
  return snapshot(value, { active: new Set(), items: 0, bytes: 0 });
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function validByteRange(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) return false;
  const [firstOffset, firstLength, secondOffset, secondLength] = value;
  return firstOffset === 0 && firstLength > 0 && secondOffset > firstLength
    && secondLength > 0 && secondOffset + secondLength <= Number.MAX_SAFE_INTEGER;
}

function derivedIntegrity(signatures) {
  if (signatures.length === 0) return 'unsigned';
  if (signatures.some(({ integrity }) => integrity === 'invalid')) return 'invalid';
  if (signatures.some(({ integrity }) => integrity === 'indeterminate')) return 'indeterminate';
  return 'valid';
}

function derivedCoverage(signatures) {
  if (signatures.length === 0) return 'unsigned';
  if (signatures.every(({ documentCoverage }) => documentCoverage === 'full')) return 'full';
  if (signatures.every(({ documentCoverage }) => documentCoverage === 'prior-revision')) return 'prior-revision';
  return 'mixed';
}

function derivedCurrent(status, coverage) {
  if (status === 'unsigned' || status === 'invalid' || status === 'indeterminate') return status;
  return coverage === 'full' ? 'valid' : 'modified-after-signing';
}

function expectedSummary(status, count) {
  return status === 'unsigned' ? 'No embedded signatures' : `${count} embedded signature${count === 1 ? '' : 's'} · ${status} integrity evidence`;
}

function pathSummary(statuses) {
  if (statuses.every((status) => status === 'passes')) return 'all-pass';
  if (statuses.every((status) => status === 'fails')) return 'all-fail';
  if (statuses.some((status) => status === 'indeterminate')) return 'indeterminate';
  if (statuses.every((status) => status === 'unsupported')) return 'unsupported';
  return 'mixed';
}

function crossCheck(signatures) {
  const verifiedCount = signatures.filter(({ certificateChain }) => ['passes', 'fails'].includes(certificateChain.status)).length;
  const indeterminateCount = signatures.filter(({ certificateChain }) => certificateChain.status === 'indeterminate').length;
  const unsupportedCount = signatures.filter(({ certificateChain }) => certificateChain.status === 'unsupported').length;
  const reasons = [...new Set(signatures.filter(({ certificateChain }) => ['indeterminate', 'unsupported'].includes(certificateChain.status)).map(({ certificateChain }) => certificateChain.reason))].sort();
  return {
    status: indeterminateCount + unsupportedCount === 0 ? 'verified' : 'indeterminate',
    verifiedCount, indeterminateCount, unsupportedCount, reasons,
  };
}

function combinedCurrent(status, currentDocumentStatus, crossCheckStatus) {
  if (status === 'invalid' || currentDocumentStatus === 'invalid') return 'invalid';
  if (status !== 'valid' || crossCheckStatus !== 'verified') return 'indeterminate';
  if (currentDocumentStatus === 'modified-after-signing') return 'modified-after-signing';
  return currentDocumentStatus === 'valid' ? 'valid' : 'indeterminate';
}

function canonicalTimestamp(value) {
  return typeof value === 'string' && ISO_TIME.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function certificateChain(value) {
  exactRecord(value, ['status', 'reason', 'chainLength'], 'Certificate-path evidence');
  if (!CERTIFICATE_PATH_STATUSES.includes(value.status) || !CHAIN_REASONS.includes(value.reason)) invalid('certificate path is invalid.');
  const boundedLength = Number.isSafeInteger(value.chainLength) && value.chainLength >= 1 && value.chainLength <= 16;
  if ((value.status === 'passes' && (value.reason !== 'none' || !boundedLength))
    || (value.status === 'fails' && (value.reason === 'none' || !boundedLength))
    || (value.status === 'unsupported' && (value.reason !== 'unsupported-subfilter' || value.chainLength !== null))
    || (value.status === 'indeterminate' && (value.reason === 'none' || value.chainLength !== null))) invalid('certificate path status is inconsistent.');
}

function validateSignature(value, index, enriched) {
  exactRecord(value, [
    'index', 'claimedSigner', 'claimedSigningTime', 'hashAlgorithm', 'signatureType',
    'byteRange', 'documentCoverage', 'integrity', 'certificate', 'revocation',
    'timestamp', 'identityVerified', ...(enriched ? ['certificateChain'] : []),
  ], 'Signature evidence record');
  exactRecord(value.claimedSigner, ['commonName', 'distinguishedName'], 'Claimed signer');
  boundedText(value.claimedSigner.commonName, 'claimed signer common name', { nullable: true });
  boundedText(value.claimedSigner.distinguishedName, 'claimed signer distinguished name', { nullable: true });
  boundedText(value.claimedSigningTime, 'claimed signing time', { nullable: true });
  safeToken(value.hashAlgorithm, HASH_ALGORITHM, 'signature hash algorithm');
  safeToken(value.signatureType, SIGNATURE_TYPE, 'signature type');
  if (value.index !== index + 1 || !validByteRange(value.byteRange)
    || !['full', 'prior-revision'].includes(value.documentCoverage)
    || !['valid', 'invalid', 'indeterminate'].includes(value.integrity)
    || !CERTIFICATE_STATUSES.includes(value.certificate)
    || value.revocation !== 'not-checked' || value.timestamp !== 'not-checked'
    || value.identityVerified !== false) invalid('signature evidence record is inconsistent.');
  if (!enriched && value.certificate !== 'not-checked') invalid('v1 evidence must not claim certificate-path evaluation.');
  if (enriched) {
    certificateChain(value.certificateChain);
    if (value.certificate !== value.certificateChain.status) invalid('certificate status does not match its record.');
  }
}

function validateEvidence(value) {
  const v1Keys = [
    'sourceSha256', 'schemaVersion', 'profile', 'status', 'integrityStatus', 'coverageStatus',
    'currentDocumentStatus', 'count', 'signatureCount', 'summary', 'signatures', 'limitations',
  ];
  const v2Keys = [...v1Keys, 'popplerEvidence', 'cmsCrossCheck', 'overallCurrentDocumentStatus', 'certificateChainSummary', 'certificateEvaluation'];
  if (![1, 2].includes(value?.schemaVersion)) invalid('schema version is unsupported.');
  const enriched = value.schemaVersion === 2;
  exactRecord(value, enriched ? v2Keys : v1Keys, 'Signature evidence');
  if (!SHA256.test(value.sourceSha256) || value.profile !== 'poppler-offline-integrity-v1'
    || !SIGNATURE_STATUSES.includes(value.status) || !CURRENT_DOCUMENT_STATUSES.includes(value.currentDocumentStatus)
    || !Array.isArray(value.signatures) || value.signatures.length > MAX_SIGNATURES
    || !Number.isSafeInteger(value.signatureCount) || value.signatureCount < 0 || value.signatureCount > MAX_SIGNATURES
    || value.signatureCount !== value.signatures.length || !Number.isSafeInteger(value.count)
    || value.count !== value.signatures.length) invalid('evidence identity or count is invalid.');
  boundedText(value.summary, 'summary', { nonEmpty: true });
  if (!Array.isArray(value.limitations) || value.limitations.length < 1 || value.limitations.length > 16
    || value.limitations.some((item) => { boundedText(item, 'limitation', { nonEmpty: true }); return false; })) invalid('limitations are invalid.');
  value.signatures.forEach((signature, index) => validateSignature(signature, index, enriched));
  const status = derivedIntegrity(value.signatures);
  const coverage = derivedCoverage(value.signatures);
  const current = derivedCurrent(status, coverage);
  if (value.status !== status || value.integrityStatus !== status || value.coverageStatus !== coverage
    || value.currentDocumentStatus !== current || value.summary !== expectedSummary(status, value.signatures.length)) invalid('summary fields are inconsistent.');
  if (!enriched) return;
  if (value.status !== 'valid' || value.signatures.length < 1) invalid('enriched evidence requires valid signatures.');
  exactRecord(value.popplerEvidence, ['engine', 'integrityStatus', 'currentDocumentStatus'], 'Poppler evidence');
  if (value.popplerEvidence.engine !== 'Poppler pdfsig' || value.popplerEvidence.integrityStatus !== value.status
    || value.popplerEvidence.currentDocumentStatus !== value.currentDocumentStatus) invalid('Poppler evidence is inconsistent.');
  exactRecord(value.cmsCrossCheck, ['status', 'verifiedCount', 'indeterminateCount', 'unsupportedCount', 'reasons'], 'CMS cross-check');
  const expectedCrossCheck = crossCheck(value.signatures);
  if (!['verified', 'indeterminate'].includes(value.cmsCrossCheck.status)
    || ![value.cmsCrossCheck.verifiedCount, value.cmsCrossCheck.indeterminateCount, value.cmsCrossCheck.unsupportedCount].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= MAX_SIGNATURES)
    || value.cmsCrossCheck.status !== expectedCrossCheck.status
    || value.cmsCrossCheck.verifiedCount !== expectedCrossCheck.verifiedCount
    || value.cmsCrossCheck.indeterminateCount !== expectedCrossCheck.indeterminateCount
    || value.cmsCrossCheck.unsupportedCount !== expectedCrossCheck.unsupportedCount
    || !Array.isArray(value.cmsCrossCheck.reasons) || value.cmsCrossCheck.reasons.length !== expectedCrossCheck.reasons.length
    || value.cmsCrossCheck.reasons.some((reason, index) => reason !== expectedCrossCheck.reasons[index])) invalid('CMS cross-check is inconsistent.');
  if (!['all-pass', 'all-fail', 'indeterminate', 'unsupported', 'mixed'].includes(value.certificateChainSummary)
    || value.certificateChainSummary !== pathSummary(value.signatures.map(({ certificateChain }) => certificateChain.status))
    || value.overallCurrentDocumentStatus !== combinedCurrent(value.status, value.currentDocumentStatus, expectedCrossCheck.status)) invalid('certificate conclusions are inconsistent.');
  exactRecord(value.certificateEvaluation, ['profile', 'evaluatedAt', 'verificationTimeBasis', 'anchorBasis', 'certificateNetworkFetchAllowed'], 'Certificate-path evaluation');
  if (value.certificateEvaluation.profile !== 'macos-basic-x509-current-trust-v2'
    || !canonicalTimestamp(value.certificateEvaluation.evaluatedAt)
    || value.certificateEvaluation.verificationTimeBasis !== 'host-current-time'
    || value.certificateEvaluation.anchorBasis !== 'current-macos-trust-configuration'
    || value.certificateEvaluation.certificateNetworkFetchAllowed !== false) invalid('certificate evaluation scope is invalid.');
}

function validateResponse(body) {
  const copied = snapshotEvidence(body);
  exactRecord(copied, ['signatures'], 'Signature response');
  validateEvidence(copied.signatures);
  return freeze(copied.signatures);
}

function boundedIntentText(value, label, maximumCharacters, maximumBytes) {
  if (typeof value !== 'string' || value.length < 1 || Array.from(value).length > maximumCharacters
    || textBytes(value) > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Electronic signing intent ${label} is invalid.`);
  }
}

function electronicRequest(request) {
  const copied = snapshotEvidence(request);
  exactRecord(copied, ['profile', 'sourceSha256', 'expectedRevision', 'signer', 'intent', 'consent'], 'Electronic signing-intent request');
  if (copied.profile !== ELECTRONIC_INTENT_PROFILE || !SHA256.test(copied.sourceSha256 ?? '')
    || !Number.isSafeInteger(copied.expectedRevision) || copied.expectedRevision < 0
    || copied.consent !== true) throw new TypeError('Electronic signing intent request is invalid.');
  boundedIntentText(copied.signer, 'signer', 80, 320);
  boundedIntentText(copied.intent, 'intent', 200, 800);
  return freeze(copied);
}

function validateElectronicResponse(body, { documentId, request }) {
  const copied = snapshotEvidence(body);
  exactRecord(copied, ['result'], 'Electronic signing-intent response');
  exactRecord(copied.result, ELECTRONIC_RESULT_KEYS, 'Electronic signing-intent result');
  const result = copied.result;
  if (result.kind !== 'electronic-signing-intent' || result.profile !== ELECTRONIC_INTENT_PROFILE
    || result.documentId !== documentId || result.sourceSha256 !== request.sourceSha256
    || result.workspaceRevision !== request.expectedRevision + 1
    || typeof result.recordId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result.recordId)
    || !SHA256.test(result.signerSha256 ?? '') || !SHA256.test(result.intentSha256 ?? '')
    || result.consentRecorded !== true || result.localOnly !== true
    || result.certificateSignature !== false || result.identityVerified !== false
    || result.timestampTrusted !== false || result.legalEffectDetermined !== false
    || !Array.isArray(result.limitations) || result.limitations.length < 1 || result.limitations.length > 8) {
    throw new TypeError('Electronic signing intent result is invalid.');
  }
  for (const limitation of result.limitations) boundedText(limitation, 'electronic signing-intent limitation', { nonEmpty: true });
  return freeze(result);
}

export function createSigningEndpoints({ json }) {
  return Object.freeze({
    listSigningIdentities(options = {}) {
      if (!exactObject(options, options?.signal === undefined ? [] : ['signal']) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Signing identity options are invalid.');
      return json('/api/signing-identities', { method: 'GET', signal: options.signal });
    },
    signCertificate(documentId, request, options = {}) {
      const keys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, keys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Certificate signature options are invalid.');
      const fixed = normalizeCertificateSignatureRequest(request);
      return json(`/api/documents/${encodeURIComponent(documentId)}/certificate-sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixed), signal: options.signal }).then((body) => body?.result);
    },
    validateCertificateSignatures(documentId, options = {}) {
      const keys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, keys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Certificate validation options are invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/signatures`, { method: 'GET', signal: options.signal }).then((body) => {
        return validateResponse(body);
      });
    },
    recordElectronicSigningIntent(documentId, request, options = {}) {
      const keys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, keys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Electronic signing intent options are invalid.');
      }
      const fixed = electronicRequest(request);
      return json(`/api/documents/${encodeURIComponent(documentId)}/electronic-signing-intent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fixed), signal: options.signal,
      }).then((body) => validateElectronicResponse(body, { documentId, request: fixed }));
    },
  });
}
