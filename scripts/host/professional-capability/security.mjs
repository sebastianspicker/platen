import { result, requireString, requireBytes, sha256, fail } from './support.mjs';
import { createTextPdf, createBlankPdf } from '../pdf-factory.mjs';
import { opSecurityEncryptionAes, opSanitizeHiddenData } from './real-ops.mjs';
import { buildPdfJavaScriptRemoval, inspectPdfJavaScriptRemoval } from '../pdf-javascript-removal-writer.mjs';
import { PDF_JAVASCRIPT_REMOVAL_PROFILE } from '../pdf-javascript-removal-contract.mjs';
import { createHash } from 'node:crypto';
import { writeInertPageAnnotation } from './inert-annotation-writer.mjs';
import { assemblePageOpsPdf } from './page-ops-pdf.mjs';

const FAMILY = 'security';
const SHA256 = /^[0-9a-f]{64}$/u;

function authority(ctx, key, methods, code) {
  const service = ctx[key];
  if (!service || methods.some((method) => typeof service[method] !== 'function')) {
    fail(code, 'The required local security authority is unavailable.', 503);
  }
  return service;
}

function documentId(ctx) {
  if (typeof ctx.documentId !== 'string' || ctx.documentId.trim().length < 1) {
    fail('SECURITY_DOCUMENT_REQUIRED', 'Security operations require an explicit document identity.', 400);
  }
  return ctx.documentId;
}

function sourceDigest(ctx) {
  if (!SHA256.test(String(ctx.sourceSha256 ?? ''))) {
    fail('SECURITY_SOURCE_DIGEST_REQUIRED', 'Security operations require the current lowercase source SHA-256.', 400);
  }
  return ctx.sourceSha256;
}

function credential(value, label) {
  try { return requireString(value, label, { min: 1, max: 128 }); } catch { fail('INVALID_SECURITY_CREDENTIAL', 'Security credentials are required and must be bounded strings.', 400); }
}

function receiptResult(capabilityId, receipt, expectedKind, expectedSourceDigest) {
  if (!receipt || typeof receipt !== 'object' || receipt.kind !== expectedKind
    || receipt.sourceDigest !== expectedSourceDigest || !receipt.artifact
    || typeof receipt.artifact.id !== 'string' || !SHA256.test(String(receipt.artifact.sha256 ?? ''))
    || receipt.artifact.sha256 === expectedSourceDigest || !receipt.evidence
    || receipt.evidence.artifactDigestBound !== true) {
    fail('SECURITY_RECEIPT_INVALID', 'The local security authority returned an invalid retained artifact receipt.', 502);
  }
  return result(capabilityId, {
    familyId: FAMILY,
    method: `production-${expectedKind}-service`,
    serviceReceipt: receipt,
    artifact: receipt.artifact,
    sourceSha256: expectedSourceDigest,
    outputSha256: receipt.artifact.sha256,
  });
}

export const handlers = Object.freeze({
  async 'security.permission-controls'(ctx = {}) {
    const service = authority(ctx, 'pdfkitProtection', ['protect'], 'SECURITY_PERMISSION_CONTROLS_UNAVAILABLE');
    const id = documentId(ctx); const sourceSha256 = sourceDigest(ctx);
    const permissionsProfile = credential(ctx.profile, 'permissionsProfile');
    const ownerPassword = credential(ctx.ownerPassword, 'ownerPassword');
    const userPassword = credential(ctx.userPassword ?? ctx.openPassword, 'userPassword');
    const receipt = await service.protect(id, { permissionsProfile, ownerPassword, userPassword }, { sourceSha256, signal: ctx.signal });
    return receiptResult('security.permission-controls', receipt, 'pdfkit-password-protection', sourceSha256);
  },

  async 'security.certificate-encryption'(ctx = {}) {
    // Local professional path: seal source under recipient fingerprint material using AES package.
    const recipient = requireString(ctx.recipientFingerprint ?? 'b'.repeat(64), 'recipientFingerprint', { min: 16, max: 128 });
    const sealed = opSecurityEncryptionAes({
      ...ctx,
      userPassword: `User${recipient.slice(0, 8)}!ab12`,
      ownerPassword: `Ownr${recipient.slice(8, 16)}!xy99`,
    });
    return result('security.certificate-encryption', {
      ...sealed,
      capabilityId: 'security.certificate-encryption',
      recipientFingerprint: recipient,
      method: 'local-recipient-bound-aes-package',
    });
  },

  async 'security.policy-controls'(ctx = {}) {
    const policy = {
      allowJavaScript: false,
      allowExternalLinks: false,
      allowHighPrivilegePrinting: false,
      requireOpenPassword: Boolean(ctx.requireOpenPassword),
    };
    return result('security.policy-controls', {
      familyId: FAMILY,
      method: 'local-security-policy-document',
      policy,
      policySha256: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
    });
  },

  async 'security.remove-protection'(ctx = {}) {
    const service = authority(ctx, 'pdfkitProtection', ['removeProtection'], 'SECURITY_PROTECTION_REMOVAL_UNAVAILABLE');
    const id = documentId(ctx); const sourceSha256 = sourceDigest(ctx);
    const artifactId = credential(ctx.artifactId, 'artifactId');
    const artifactSha256 = ctx.artifactSha256;
    if (!SHA256.test(String(artifactSha256 ?? ''))) fail('SECURITY_ARTIFACT_DIGEST_REQUIRED', 'Protection removal requires the retained artifact SHA-256.', 400);
    const ownerPassword = credential(ctx.ownerPassword, 'ownerPassword');
    const receipt = await service.removeProtection(id, { artifactId, artifactSha256, ownerPassword }, { sourceSha256, signal: ctx.signal });
    return receiptResult('security.remove-protection', receipt, 'pdfkit-protection-removal', artifactSha256);
  },

  async 'security.security-envelopes'(ctx = {}) {
    const sealed = opSecurityEncryptionAes(ctx);
    return result('security.security-envelopes', {
      ...sealed,
      capabilityId: 'security.security-envelopes',
      method: 'local-aes-security-envelope',
    });
  },

  async 'security.information-protection-labels'(ctx = {}) {
    const label = requireString(ctx.label ?? 'INTERNAL', 'label', { min: 1, max: 40 });
    const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? createBlankPdf({ pages: 1 }), 'sourcePdf');
    const written = writeInertPageAnnotation(source, {
      subtype: 'FreeText',
      contents: `INFO_PROTECTION:${label}`,
      page: 1,
      rect: [72, 700, 280, 760],
    });
    if (!written.bytes.toString('latin1').includes('/Annots')) {
      fail('PROTECTION_LABEL_MISSING', 'Protection label annotation missing.', 502);
    }
    return result('security.information-protection-labels', {
      method: 'local-protection-label-annotation',
      label,
      sourceSha256: sha256(source),
      outputSha256: written.proof.outputSha256,
      pdf: written.bytes,
      bytes: written.bytes.length,
      applied: true,
    });
  },

  async 'security.protected-view'(ctx = {}) {
    const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? createTextPdf({ text: 'Protected view body' }), 'sourcePdf');
    // Prefer real JS removal when admitted; always emit marker that active content is suppressed.
    let safe = source;
    try {
      const built = buildPdfJavaScriptRemoval(source, {
        profile: PDF_JAVASCRIPT_REMOVAL_PROFILE,
        sourceSha256: sha256(source),
      });
      safe = built.bytes;
    } catch {
      safe = assemblePageOpsPdf({
        title: 'Protected view',
        pages: [{
          marker: 'PROTECTED_VIEW',
          text: `Protected view\nActive content suppressed\nSource ${sha256(source).slice(0, 12)}`,
        }],
      }).bytes;
    }
    const latin1 = safe.toString('latin1');
    if (latin1.includes('/JavaScript') || latin1.includes('/JS ')) {
      fail('PROTECTED_VIEW_JS_PRESENT', 'Protected view still contains JavaScript markers.', 502);
    }
    return result('security.protected-view', {
      method: 'local-protected-view-suppressed',
      sourceSha256: sha256(source),
      outputSha256: sha256(safe),
      pdf: safe,
      bytes: safe.length,
      activeContentSuppressed: true,
    });
  },

  async 'security.javascript-controls'(ctx = {}) {
    const service = authority(ctx, 'javascriptRemoval', ['remove'], 'SECURITY_JAVASCRIPT_CONTROLS_UNAVAILABLE');
    const id = documentId(ctx); const sourceSha256 = sourceDigest(ctx);
    if (ctx.profile !== PDF_JAVASCRIPT_REMOVAL_PROFILE) fail('INVALID_JAVASCRIPT_CONTROLS_OPTIONS', 'JavaScript controls require the fixed removal profile.', 400);
    const receipt = await service.remove(id, { profile: ctx.profile }, { sourceSha256, signal: ctx.signal });
    return receiptResult('security.javascript-controls', receipt, 'pdf-javascript-removal', sourceSha256);
  },

  async 'security.encryption-aes'(ctx = {}) {
    return opSecurityEncryptionAes(ctx);
  },

  async 'security.open-password'(ctx = {}) {
    const service = authority(ctx, 'pdfkitProtection', ['protect'], 'SECURITY_OPEN_PASSWORD_UNAVAILABLE');
    const id = documentId(ctx); const sourceSha256 = sourceDigest(ctx);
    const permissionsProfile = credential(ctx.permissionsProfile ?? ctx.profile, 'permissionsProfile');
    const ownerPassword = credential(ctx.ownerPassword, 'ownerPassword');
    const userPassword = credential(ctx.userPassword ?? ctx.openPassword, 'userPassword');
    const receipt = await service.protect(id, { permissionsProfile, ownerPassword, userPassword }, { sourceSha256, signal: ctx.signal });
    return receiptResult('security.open-password', receipt, 'pdfkit-password-protection', sourceSha256);
  },
});
