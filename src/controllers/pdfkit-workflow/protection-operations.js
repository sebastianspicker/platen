import { normalizePdfKitProtection, normalizePdfKitProtectionRemoval } from '../../core/pdfkit-workflow-contract.js';

export function createPdfKitProtectionOperations({
  state, client, browserDocument, captureOperation, operationIsCurrent, reportOperationError,
  finishOperation, render, showError, downloadDerivedArtifact, downloadEphemeralDerivedArtifact, confirm, ready,
}) {
  function readPdfKitProtectionForm() {
    const entries = [['permissionsProfile', '#pdfkit-protection-profile'], ['userPassword', '#pdfkit-user-password'], ['userConfirmation', '#pdfkit-user-password-confirmation'], ['ownerPassword', '#pdfkit-owner-password'], ['ownerConfirmation', '#pdfkit-owner-password-confirmation']];
    const fields = Object.fromEntries(entries.map(([key, selector]) => [key, browserDocument.querySelector(selector)]));
    const values = Object.fromEntries(Object.entries(fields).map(([key, element]) => [key, element?.value ?? '']));
    for (const key of ['userPassword', 'userConfirmation', 'ownerPassword', 'ownerConfirmation']) if (fields[key]) fields[key].value = '';
    return normalizePdfKitProtection(values);
  }

  async function runPdfKitProtection() {
    if (!ready('pdfkitProtectionReady')) return;
    let protection; try { protection = readPdfKitProtectionForm(); } catch (error) { showError(error); return; }
    if (!confirm('Create a separate AES-128 password-protected PDF? Passwords cannot be recovered. PDF permissions are advisory, and PDFKit rewrites object structure. The source stays unchanged.')) { protection.ownerPassword = ''; protection.userPassword = ''; return; }
    const operation = captureOperation(); state.busyAction = 'Creating and validating a password-protected PDF…'; state.error = null; state.pdfkitProtectionResult = null; state.pdfkitProtectionRemovalResult = null; render();
    try {
      const result = await client.protectPdfKit(operation.documentId, state.analysis.sha256, protection, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const downloaded = await downloadDerivedArtifact(result.artifact, operation, `${result.artifact.displayName} created with fixed AES-128 password protection. The immutable source is unchanged; keep both passwords in a safe place.`);
      if (downloaded && operationIsCurrent(operation)) state.pdfkitProtectionResult = result;
    } catch (error) { reportOperationError(error, operation); } finally { protection.ownerPassword = ''; protection.userPassword = ''; finishOperation(operation); }
  }

  function readPdfKitProtectionRemovalForm() {
    const password = browserDocument.querySelector('#pdfkit-remove-owner-password');
    const confirmation = browserDocument.querySelector('#pdfkit-remove-owner-password-confirmation');
    const values = { ownerPassword: password?.value ?? '', ownerConfirmation: confirmation?.value ?? '' };
    if (password) password.value = ''; if (confirmation) confirmation.value = '';
    return normalizePdfKitProtectionRemoval(state.pdfkitProtectionResult, values);
  }

  async function runPdfKitProtectionRemoval() {
    if (!ready('pdfkitProtectionReady') || state.pdfkitProtectionResult?.kind !== 'pdfkit-password-protection') return;
    let removal; try { removal = readPdfKitProtectionRemovalForm(); } catch (error) { showError(error); return; }
    if (!confirm('Create and download a separate unencrypted PDF from this retained protected copy? The supplied password must be classified by PDFKit as owner authorization. The protected copy and immutable source remain unchanged. This does not securely erase either copy or recover, crack, or bypass a password.')) { removal.ownerPassword = ''; return; }
    const operation = captureOperation(); state.busyAction = 'Creating and validating a separate unencrypted PDF…'; state.error = null; state.pdfkitProtectionRemovalResult = null; render();
    try {
      const result = await client.removePdfKitProtection(operation.documentId, state.analysis.sha256, removal, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const downloaded = await downloadEphemeralDerivedArtifact(result.artifact, operation, `${result.artifact.displayName} created as a separately verified unencrypted PDF. The protected copy and immutable source remain unchanged.`);
      if (downloaded && operationIsCurrent(operation)) state.pdfkitProtectionRemovalResult = result;
    } catch (error) { reportOperationError(error, operation); } finally { removal.ownerPassword = ''; finishOperation(operation); }
  }

  return { runPdfKitProtection, runPdfKitProtectionRemoval };
}
