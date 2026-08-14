import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveProtectedArtifactProfile,
  normalizeProtectionRemovalRequest,
  normalizeProtectionRequest,
  PDFKIT_PROTECTION_PROFILE,
  protectionReceiptMatches,
  protectionRemovalReceiptMatches,
  serializeProtectionRemovalRequest,
  serializeProtectionRequest,
} from '../scripts/host/pdfkit-protection-contract.mjs';

const sourceSha256 = 'a'.repeat(64);
const artifactSha256 = 'b'.repeat(64);
const artifactId = '11111111-1111-4111-8111-111111111111';

function protection() {
  return normalizeProtectionRequest({
    permissionsProfile: 'copy-accessibility', ownerPassword: 'Owner-Pass-123', userPassword: 'User-Pass-4567',
  });
}

test('protection contract normalizes closed credentials and serializes only fixed helper requests', () => {
  const normalized = protection();
  assert.equal(normalized.permissions.nativeMask, 48);
  const request = JSON.parse(serializeProtectionRequest(sourceSha256, normalized));
  assert.deepEqual(request, {
    version: 1, operation: 'protect', inputFilename: 'input.pdf', outputFilename: 'output.pdf', sourceSha256,
    limits: { maxPages: 100, maxAnnotationsPerPage: 50, maxWidgetsPerPage: 50, maxOutlineDepth: 8, maxOutlineItems: 200 },
    protection: { profile: 'copy-accessibility', ownerPassword: 'Owner-Pass-123', userPassword: 'User-Pass-4567' },
  });
  assert.throws(
    () => normalizeProtectionRequest({ ...request.protection, ownerPassword: 'same-password!', userPassword: 'same-password!' }),
    { code: 'INVALID_PDFKIT_PROTECTION_OPTIONS' },
  );
  assert.equal(protectionReceiptMatches({
    sourceSha256, outputSha256: artifactSha256, profile: 'copy-accessibility', effectivePermissionMask: 48,
    effectivePermissions: ['copying', 'contentAccessibility'],
  }, { sha256: sourceSha256 }, normalized), true);
});

test('removal contract binds retained artifact provenance and excludes passwords from derived profile data', () => {
  const removal = normalizeProtectionRemovalRequest({ artifactId, artifactSha256, ownerPassword: 'Owner-Pass-123' });
  const request = JSON.parse(serializeProtectionRemovalRequest(artifactSha256, 'copy-accessibility', removal.ownerPassword));
  assert.deepEqual(request.removal, { sourceProfile: 'copy-accessibility', ownerPassword: 'Owner-Pass-123' });
  const artifact = {
    id: artifactId, documentId: 'document-1', mediaType: 'application/pdf', size: 128, sha256: artifactSha256,
    operation: {
      type: 'pdfkit-password-protection',
      parameters: { profile: PDFKIT_PROTECTION_PROFILE, permissionsProfile: 'copy-accessibility' },
      inputs: [{ documentId: 'document-1', sha256: sourceSha256, role: 'source' }],
      expected: { pageCount: 2 },
      validation: {
        passed: true, outputSha256: artifactSha256, permissionMask: 48,
        pageCount: 2, validators: ['native-password-reopen', 'classic-xref-encryption-dictionary', 'artifact-sha256'],
      },
    },
  };
  const derived = deriveProtectedArtifactProfile(artifact, { id: 'document-1', sha256: sourceSha256 });
  assert.deepEqual(derived, { profile: 'copy-accessibility', permissions: { nativeMask: 48, pdfPermissionValue: -3376, effectivePermissions: ['copying', 'contentAccessibility'] }, pageCount: 2 });
  assert.doesNotMatch(JSON.stringify(derived), /Owner-Pass-123/);
  assert.equal(protectionRemovalReceiptMatches({
    sourceSha256: artifactSha256, outputSha256: sourceSha256, sourceProfile: 'copy-accessibility', pageCount: 2,
    ownerAuthorizationVerified: true, encryptionRemoved: true, reopenVerified: true,
  }, artifact, 'copy-accessibility', 2), true);
});
