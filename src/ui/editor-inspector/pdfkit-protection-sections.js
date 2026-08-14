import {
  pdfkitMetadataSanitizationResult,
  pdfkitProtectionRemovalResult,
  pdfkitProtectionResult,
} from '../editor-result-views.js';

export function pdfkitProtectionSections(state, readiness) {
  const {
    pdfkitProtectionReady,
    pdfkitProtectionRemovalReady,
    pdfkitSanitizationReady,
  } = readiness;
  return `
      <section class="property-section pdfkit-protection-section">
        <h3>Metadata sanitization</h3>
        <p class="field-help">Creates a separate fresh PDF and removes only document Info fields, custom Info fields, and catalog XMP. The helper accepts a strict passive source graph, scrubs PDFKit writer metadata, reopens the result, and compares page count, geometry, rotations, passive annotations, safe local bookmarks, extracted text hashes, and fixed rendered-page hashes. Poppler independently requires standard metadata, custom metadata, and XMP to be absent before the artifact is published.</p>
        <button class="button danger-button" data-action="sanitize-pdfkit-metadata" ${pdfkitSanitizationReady ? '' : 'disabled'}>Create metadata-sanitized PDF</button>
        <p class="field-help">Encrypted, signed or signature-indeterminate, form-bearing, tagged, layered, name-tree, page-label, attachment, URL/action, page-metadata, active-media, malformed, and unsupported graphs fail closed. This does not remove visible content, comments, hidden objects, orphan bytes, prior revisions, steganography, or downloaded/source copies; it is not secure erasure or broad hidden-data sanitization.</p>
        ${state.host?.pdfkitSanitizationReady ? (pdfkitSanitizationReady ? '' : '<p class="field-help">This document does not meet every fixed metadata-sanitization precondition, or its local inspection evidence is incomplete.</p>') : '<p class="field-help">Build the optional release helper with npm run native:build:pdfkit to enable verified local metadata sanitization on macOS.</p>'}
        ${pdfkitMetadataSanitizationResult(state)}
      </section>
      <section class="property-section pdfkit-protection-section">
        <h3>Password protection</h3>
        <p class="field-help">Creates a separate PDF with the pinned macOS PDFKit helper and a fixed Standard Security Handler AES-128 profile. Credentials cross the token-authenticated same-origin loopback HTTP boundary as bounded JSON, then reach the helper through bounded process input. They are not intentionally retained in app state, files, results, provenance, command arguments, or application logs, and these fields are cleared immediately. Browser developer tools, network instrumentation, and process runtimes may retain transient copies that cannot be reliably zeroed.</p>
        <label class="field-label" for="pdfkit-protection-profile">Advisory permissions profile</label>
        <select id="pdfkit-protection-profile" ${pdfkitProtectionReady ? '' : 'disabled'}>
          <option value="accessibility-only">Allow accessibility extraction only</option>
          <option value="copy-accessibility">Allow copying and accessibility extraction</option>
          <option value="print-only">Allow printing only</option>
          <option value="deny-all">Deny all optional operations</option>
        </select>
        <label class="field-label" for="pdfkit-user-password">Open password</label>
        <input id="pdfkit-user-password" type="password" minlength="12" maxlength="16" autocomplete="new-password" spellcheck="false" autocapitalize="none" ${pdfkitProtectionReady ? '' : 'disabled'} />
        <label class="field-label" for="pdfkit-user-password-confirmation">Confirm open password</label>
        <input id="pdfkit-user-password-confirmation" type="password" minlength="12" maxlength="16" autocomplete="new-password" spellcheck="false" autocapitalize="none" ${pdfkitProtectionReady ? '' : 'disabled'} />
        <label class="field-label" for="pdfkit-owner-password">Owner password</label>
        <input id="pdfkit-owner-password" type="password" minlength="12" maxlength="32" autocomplete="new-password" spellcheck="false" autocapitalize="none" ${pdfkitProtectionReady ? '' : 'disabled'} />
        <label class="field-label" for="pdfkit-owner-password-confirmation">Confirm owner password</label>
        <input id="pdfkit-owner-password-confirmation" type="password" minlength="12" maxlength="32" autocomplete="new-password" spellcheck="false" autocapitalize="none" ${pdfkitProtectionReady ? '' : 'disabled'} />
        <button class="button primary" data-action="create-pdfkit-protected-copy" ${pdfkitProtectionReady ? '' : 'disabled'}>Create protected PDF</button>
        <p class="field-help">Use a 12–16 character open password and a distinct 12–32 character owner password in printable ASCII with no edge spaces. The open-password ceiling avoids a measured PDFKit owner-classification defect for lengths 17–31. There is no password recovery. Permissions are advisory after opening. The four fixed presets deny all optional operations or allow only accessibility extraction, printing, or copying plus accessibility extraction. This conservative boundary accepts only unencrypted, untagged PDFs of at most 100 pages with no forms, JavaScript, signatures, attachments, or external URLs; the host rechecks every condition before writing.</p>
        ${state.host?.pdfkitProtectionReady ? (pdfkitProtectionReady ? '' : '<p class="field-help">This document does not meet every fixed protection precondition, or its local inspection evidence is incomplete.</p>') : '<p class="field-help">Build the optional release helper with npm run native:build:pdfkit to enable fixed local AES-128 protection on macOS.</p>'}
        ${pdfkitProtectionResult(state)}
        ${state.pdfkitProtectionResult?.kind === 'pdfkit-password-protection' ? `<div class="nested-control-group" role="group" aria-labelledby="pdfkit-remove-protection-heading">
          <h4 id="pdfkit-remove-protection-heading">Remove protection from this retained copy</h4>
          <p class="field-help">Creates and downloads a separate cleartext PDF only from the exact protected artifact created in this local session. Enter its owner password; the helper must classify that credential as owner authorization before it writes anything.</p>
          <label class="field-label" for="pdfkit-remove-owner-password">Owner password</label>
          <input id="pdfkit-remove-owner-password" type="password" minlength="12" maxlength="32" autocomplete="new-password" spellcheck="false" autocapitalize="none" ${pdfkitProtectionRemovalReady ? '' : 'disabled'} />
          <label class="field-label" for="pdfkit-remove-owner-password-confirmation">Confirm owner password</label>
          <input id="pdfkit-remove-owner-password-confirmation" type="password" minlength="12" maxlength="32" autocomplete="new-password" spellcheck="false" autocapitalize="none" ${pdfkitProtectionRemovalReady ? '' : 'disabled'} />
          <button class="button danger-button" data-action="remove-pdfkit-protection" ${pdfkitProtectionRemovalReady ? '' : 'disabled'}>Create separate unencrypted PDF</button>
          <p class="field-help">The local host treats the cleartext artifact as ephemeral and deletes it after the one download transfer; the downloaded file remains under your control. The protected artifact and immutable original remain retained and unchanged. This narrow current-session workflow is not password recovery, cracking, bypass, arbitrary decryption, secure erasure, signature-safe rewriting, sanitization, redaction, or byte/object preservation. PDFKit owner classification is a technical authorization check, not proof of legal ownership. The owner credential crosses the same bounded loopback JSON and helper-input path described above. The fields are cleared immediately, but developer tools, instrumentation, and runtime memory may retain transient copies.</p>
          ${pdfkitProtectionRemovalResult(state)}
        </div>` : ''}
      </section>`;
}
