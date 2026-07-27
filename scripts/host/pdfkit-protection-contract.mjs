import { HostError } from './host-error.mjs';

export const PDFKIT_PROTECTION_PROFILE = 'macos-pdfkit-aes128-v1';
export const PDFKIT_PROTECTION_REMOVAL_PROFILE = 'macos-pdfkit-remove-protection-v1';
export const PDFKIT_PROTECTION_LIMITS = Object.freeze({
  maxPages: 100,
  maxAnnotationsPerPage: 50,
  maxWidgetsPerPage: 50,
  maxOutlineDepth: 8,
  maxOutlineItems: 200,
});

const MAX_REQUEST_BYTES = 2 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_PASSWORD = /^[\x20-\x7e]{12,32}$/;
const OPEN_PASSWORD = /^[\x20-\x7e]{12,16}$/;
const PERMISSION_PROFILES = Object.freeze({
  'accessibility-only': Object.freeze({ nativeMask: 32, pdfPermissionValue: -3392, effectivePermissions: Object.freeze(['contentAccessibility']) }),
  'copy-accessibility': Object.freeze({ nativeMask: 48, pdfPermissionValue: -3376, effectivePermissions: Object.freeze(['copying', 'contentAccessibility']) }),
  'deny-all': Object.freeze({ nativeMask: 0, pdfPermissionValue: -3904, effectivePermissions: Object.freeze([]) }),
  'print-only': Object.freeze({ nativeMask: 3, pdfPermissionValue: -1852, effectivePermissions: Object.freeze(['printing']) }),
});

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

function exactObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

export function normalizeProtectionRequest(value) {
  if (!exactObject(value, ['permissionsProfile', 'ownerPassword', 'userPassword'])) {
    fail('INVALID_PDFKIT_PROTECTION_OPTIONS', 'Password protection requires exactly the fixed local fields.');
  }
  const permissions = Object.hasOwn(PERMISSION_PROFILES, value.permissionsProfile)
    ? PERMISSION_PROFILES[value.permissionsProfile] : null;
  if (!permissions || typeof value.ownerPassword !== 'string' || typeof value.userPassword !== 'string'
    || !OWNER_PASSWORD.test(value.ownerPassword) || !OPEN_PASSWORD.test(value.userPassword)
    || value.ownerPassword.trim() !== value.ownerPassword || value.userPassword.trim() !== value.userPassword
    || value.ownerPassword === value.userPassword) {
    fail('INVALID_PDFKIT_PROTECTION_OPTIONS', 'Use a 12–16 character open password and a distinct 12–32 character owner password in printable ASCII with no edge whitespace.');
  }
  return Object.freeze({ permissionsProfile: value.permissionsProfile, ownerPassword: value.ownerPassword, userPassword: value.userPassword, permissions });
}

export function normalizeProtectionRemovalRequest(value) {
  if (!exactObject(value, ['artifactId', 'artifactSha256', 'ownerPassword'])
    || !OPAQUE_ID.test(String(value.artifactId ?? '')) || !SHA256.test(String(value.artifactSha256 ?? ''))
    || typeof value.ownerPassword !== 'string' || !OWNER_PASSWORD.test(value.ownerPassword)
    || value.ownerPassword.trim() !== value.ownerPassword) {
    fail('INVALID_PDFKIT_PROTECTION_REMOVAL_OPTIONS', 'Protection removal requires the exact protected artifact and its 12–32 character printable-ASCII owner password with no edge whitespace.');
  }
  return Object.freeze({ artifactId: value.artifactId, artifactSha256: value.artifactSha256, ownerPassword: value.ownerPassword });
}

function serialize(payload, code, message) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  if (bytes.length > MAX_REQUEST_BYTES) { bytes.fill(0); fail(code, message, 413); }
  return bytes;
}

export function serializeProtectionRequest(sourceSha256, normalized) {
  return serialize({ version: 1, operation: 'protect', inputFilename: 'input.pdf', outputFilename: 'output.pdf', sourceSha256, limits: PDFKIT_PROTECTION_LIMITS, protection: { profile: normalized.permissionsProfile, ownerPassword: normalized.ownerPassword, userPassword: normalized.userPassword } }, 'INVALID_PDFKIT_PROTECTION_OPTIONS', 'The fixed password protection request is too large.');
}

export function serializeProtectionRemovalRequest(sourceSha256, sourceProfile, ownerPassword) {
  return serialize({ version: 1, operation: 'removeProtection', inputFilename: 'input.pdf', outputFilename: 'output.pdf', sourceSha256, limits: PDFKIT_PROTECTION_LIMITS, removal: { sourceProfile, ownerPassword } }, 'INVALID_PDFKIT_PROTECTION_REMOVAL_OPTIONS', 'The fixed protection-removal request is too large.');
}

export function protectionReceiptMatches(result, source, normalized) {
  return result.sourceSha256 === source.sha256 && result.outputSha256 !== source.sha256
    && result.profile === normalized.permissionsProfile && result.effectivePermissionMask === normalized.permissions.nativeMask
    && result.effectivePermissions.length === normalized.permissions.effectivePermissions.length
    && result.effectivePermissions.every((entry, index) => entry === normalized.permissions.effectivePermissions[index]);
}

export function protectionRemovalReceiptMatches(result, artifact, sourceProfile, expectedPageCount) {
  return result.sourceSha256 === artifact.sha256 && result.outputSha256 !== artifact.sha256
    && result.sourceProfile === sourceProfile && result.pageCount === expectedPageCount
    && result.ownerAuthorizationVerified === true && result.encryptionRemoved === true && result.reopenVerified === true;
}

export function deriveProtectedArtifactProfile(artifact, document) {
  const operation = artifact.operation; const profile = operation?.parameters?.permissionsProfile;
  const permissions = Object.hasOwn(PERMISSION_PROFILES, profile) ? PERMISSION_PROFILES[profile] : null;
  const validators = operation?.validation?.validators; const expectedPageCount = operation?.expected?.pageCount;
  const validatedPageCount = operation?.validation?.pageCount;
  const ownsSource = Array.isArray(operation?.inputs) && operation.inputs.some((input) => input.documentId === document.id && input.sha256 === document.sha256 && input.role === 'source');
  if (artifact.documentId !== document.id || artifact.sha256 === document.sha256 || operation?.type !== 'pdfkit-password-protection'
    || operation?.parameters?.profile !== PDFKIT_PROTECTION_PROFILE || !permissions || !ownsSource
    || operation?.validation?.passed !== true || operation.validation.outputSha256 !== artifact.sha256
    || operation.validation.permissionMask !== permissions.nativeMask || !Number.isSafeInteger(expectedPageCount)
    || expectedPageCount < 1 || expectedPageCount > PDFKIT_PROTECTION_LIMITS.maxPages || validatedPageCount !== expectedPageCount
    || !Array.isArray(validators) || !['native-password-reopen', 'classic-xref-encryption-dictionary', 'artifact-sha256'].every((validator) => validators.includes(validator))) {
    fail('PDFKIT_PROTECTION_REMOVAL_SOURCE_UNSUPPORTED', 'Protection removal accepts only a retained artifact created by this fixed local protection boundary.', 422);
  }
  return Object.freeze({ profile, permissions, pageCount: expectedPageCount });
}
