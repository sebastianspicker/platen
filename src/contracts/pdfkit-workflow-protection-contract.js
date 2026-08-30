const PROTECTION_PERMISSION_PROFILES = new Set([
  'accessibility-only', 'copy-accessibility', 'deny-all', 'print-only',
]);
const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizePdfKitProtection(values) {
  const validOwnerPassword = (value) => /^[\x20-\x7e]{12,32}$/.test(value)
    && value.trim() === value;
  const validOpenPassword = (value) => /^[\x20-\x7e]{12,16}$/.test(value)
    && value.trim() === value;
  if (!PROTECTION_PERMISSION_PROFILES.has(values.permissionsProfile)
    || !validOpenPassword(values.userPassword)
    || !validOwnerPassword(values.ownerPassword)
    || values.userPassword !== values.userConfirmation
    || values.ownerPassword !== values.ownerConfirmation
    || values.userPassword === values.ownerPassword) {
    throw new Error('Use a matching 12–16 character open password and a distinct matching 12–32 character owner password in printable ASCII with no edge whitespace.');
  }
  return {
    permissionsProfile: values.permissionsProfile,
    userPassword: values.userPassword,
    ownerPassword: values.ownerPassword,
  };
}

export function normalizePdfKitProtectionRemoval(protectionResult, values) {
  const artifact = protectionResult?.artifact;
  const ownerPassword = values.ownerPassword;
  if (protectionResult?.kind !== 'pdfkit-password-protection'
    || !ARTIFACT_ID.test(artifact?.id ?? '')
    || !SHA256.test(artifact?.sha256 ?? '')
    || !/^[\x20-\x7e]{12,32}$/.test(ownerPassword)
    || ownerPassword.trim() !== ownerPassword
    || ownerPassword !== values.ownerConfirmation) {
    throw new Error('Use the matching 12–32 character owner password for the retained protected copy, in printable ASCII with no edge whitespace.');
  }
  return { artifactId: artifact.id, artifactSha256: artifact.sha256, ownerPassword };
}
