import { PlatenError } from './errors.js';
import {
  exactObject,
  OPAQUE_ID_PATTERN,
  PDFKIT_PROTECTION_REMOVAL_PROFILE,
} from './pdfkit-client-contract-shared.js';

const PDFKIT_PROTECTION_PERMISSIONS = new Set([
  'accessibility-only', 'copy-accessibility', 'deny-all', 'print-only',
]);
const PDFKIT_PROTECTION_REMOVAL_VALIDATORS = Object.freeze([
  'protected-artifact-provenance', 'source-sha256', 'fixed-aes128-envelope',
  'native-owner-authorization', 'native-private-snapshot-match',
  'classic-xref-no-encrypt', 'poppler-unauthenticated-open',
  'poppler-all-page-render', 'artifact-sha256',
]);
const PDFKIT_PROTECTION_REMOVAL_EVIDENCE = Object.freeze([
  'protectedArtifactProvenanceVerified', 'sourceEnvelopeValidated',
  'ownerAuthorizationVerified', 'nativeContentChecksPassed',
  'finalTrailerUnencrypted', 'popplerUnauthenticatedOpenPassed',
  'allPagesRendered', 'artifactDigestBound', 'encryptedSourceRetained',
]);

export function validPdfKitProtection(protection) {
  if (!exactObject(protection, ['permissionsProfile', 'ownerPassword', 'userPassword'])
    || !PDFKIT_PROTECTION_PERMISSIONS.has(protection.permissionsProfile)
    || typeof protection.ownerPassword !== 'string'
    || typeof protection.userPassword !== 'string'
    || !/^[\x20-\x7e]{12,32}$/.test(protection.ownerPassword)
    || !/^[\x20-\x7e]{12,16}$/.test(protection.userPassword)
    || protection.ownerPassword.trim() !== protection.ownerPassword
    || protection.userPassword.trim() !== protection.userPassword
    || protection.ownerPassword === protection.userPassword) return false;
  return true;
}

export function validPdfKitProtectionRemoval(removal) {
  return exactObject(removal, ['artifactId', 'artifactSha256', 'ownerPassword'])
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(removal.artifactId ?? '')
    && /^[0-9a-f]{64}$/.test(removal.artifactSha256 ?? '')
    && typeof removal.ownerPassword === 'string'
    && /^[\x20-\x7e]{12,32}$/.test(removal.ownerPassword)
    && removal.ownerPassword.trim() === removal.ownerPassword;
}

export function validatePdfKitProtectionRemovalResult(
  result,
  { documentId, sourceSha256, removal },
) {
  const invalid = () => {
    throw new PlatenError(
      'INVALID_LOCAL_HOST',
      'The local host returned an invalid PDFKit protection-removal result.',
    );
  };
  if (!exactObject(result, ['kind', 'sourceDigest', 'artifact', 'protection', 'evidence', 'limitations'])
    || result.kind !== 'pdfkit-protection-removal'
    || result.sourceDigest !== removal.artifactSha256
    || !exactObject(result.artifact, [
      'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
    ])
    || !OPAQUE_ID_PATTERN.test(result.artifact.id ?? '')
    || result.artifact.id === removal.artifactId
    || result.artifact.documentId !== documentId
    || !OPAQUE_ID_PATTERN.test(result.artifact.documentId ?? '')
    || typeof result.artifact.displayName !== 'string' || !result.artifact.displayName
    || result.artifact.displayName.length > 240
    || /[\u0000-\u001f\u007f]/.test(result.artifact.displayName)
    || result.artifact.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(result.artifact.size) || result.artifact.size < 1
    || result.artifact.size > 256 * 1024 * 1024
    || !/^[0-9a-f]{64}$/.test(result.artifact.sha256 ?? '')
    || result.artifact.sha256 === removal.artifactSha256
    || typeof result.artifact.createdAt !== 'string'
    || Number.isNaN(Date.parse(result.artifact.createdAt))
    || !exactObject(result.protection, [
      'profile', 'sourceProtectionProfile', 'ownerAuthorizationVerified', 'encrypted',
    ])
    || result.protection.profile !== PDFKIT_PROTECTION_REMOVAL_PROFILE
    || !PDFKIT_PROTECTION_PERMISSIONS.has(result.protection.sourceProtectionProfile)
    || result.protection.ownerAuthorizationVerified !== true
    || result.protection.encrypted !== false
    || !exactObject(result.evidence, PDFKIT_PROTECTION_REMOVAL_EVIDENCE)
    || PDFKIT_PROTECTION_REMOVAL_EVIDENCE.some((key) => result.evidence[key] !== true)
    || !Array.isArray(result.limitations) || result.limitations.length !== 3
    || result.limitations.some((entry) => typeof entry !== 'string'
      || !entry || entry.length > 512)) invalid();

  const operation = result.artifact.operation;
  if (!exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt',
  ])
    || operation.schemaVersion !== 1 || !OPAQUE_ID_PATTERN.test(operation.id ?? '')
    || operation.type !== 'pdfkit-protection-removal'
    || typeof operation.completedAt !== 'string'
    || Number.isNaN(Date.parse(operation.completedAt))
    || !Array.isArray(operation.inputs) || operation.inputs.length !== 1
    || !exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    || operation.inputs[0].documentId !== documentId
    || operation.inputs[0].sha256 !== sourceSha256 || operation.inputs[0].role !== 'source'
    || !exactObject(operation.parameters, [
      'profile', 'protectedArtifactSha256', 'sourceProtectionProfile',
    ])
    || operation.parameters.profile !== PDFKIT_PROTECTION_REMOVAL_PROFILE
    || operation.parameters.protectedArtifactSha256 !== removal.artifactSha256
    || operation.parameters.sourceProtectionProfile
      !== result.protection.sourceProtectionProfile
    || !exactObject(operation.expected, [
      'pageCount', 'encrypted', 'sourceUnchanged', 'protectedArtifactRetained',
    ])
    || !Number.isSafeInteger(operation.expected.pageCount)
    || operation.expected.pageCount < 1 || operation.expected.pageCount > 100
    || operation.expected.encrypted !== false || operation.expected.sourceUnchanged !== true
    || operation.expected.protectedArtifactRetained !== true
    || !exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'outputSha256'])
    || operation.validation.passed !== true
    || operation.validation.pageCount !== operation.expected.pageCount
    || operation.validation.outputSha256 !== result.artifact.sha256
    || !Array.isArray(operation.validation.validators)
    || operation.validation.validators.length !== PDFKIT_PROTECTION_REMOVAL_VALIDATORS.length
    || operation.validation.validators.some(
      (entry, index) => entry !== PDFKIT_PROTECTION_REMOVAL_VALIDATORS[index],
    )) invalid();
  return result;
}
