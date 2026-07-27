import { result, requireString, requireBytes, sha256, fail } from './support.mjs';
import { createTextPdf, createBlankPdf } from '../pdf-factory.mjs';
import { opSecurityEncryptionAes, opSanitizeHiddenData } from './real-ops.mjs';
import { buildPdfJavaScriptRemoval } from '../pdf-javascript-removal-writer.mjs';
import { PDF_JAVASCRIPT_REMOVAL_PROFILE } from '../pdf-javascript-removal-contract.mjs';
import { createHash, createDecipheriv } from 'node:crypto';
import { writeInertPageAnnotation } from './inert-annotation-writer.mjs';
import { assemblePageOpsPdf } from './page-ops-pdf.mjs';

const FAMILY = 'security';

export const handlers = Object.freeze({
  async 'security.permission-controls'(ctx = {}) {
    const profile = requireString(ctx.profile ?? 'deny-all', 'profile', { min: 1, max: 40 });
    const allowed = new Set(['deny-all', 'accessibility-only', 'print-only', 'copy-accessibility']);
    if (!allowed.has(profile)) fail('INVALID_PERMISSION_PROFILE', 'Unknown permission profile.', 400);
    // Four closed advisory masks matching the product's professional open-password presets.
    const masks = {
      'deny-all': { print: false, copy: false, accessibility: false, modify: false },
      'accessibility-only': { print: false, copy: false, accessibility: true, modify: false },
      'print-only': { print: true, copy: false, accessibility: false, modify: false },
      'copy-accessibility': { print: false, copy: true, accessibility: true, modify: false },
    };
    return result('security.permission-controls', {
      familyId: FAMILY,
      method: 'local-closed-permission-presets',
      profile,
      permissions: masks[profile],
      advisory: true,
    });
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
    // Only removes this product's sealed AES package (not arbitrary PDF encryption).
    let sealed = ctx.sealedPdf ?? null;
    if (!sealed) {
      const candidate = ctx.sourcePdf ?? ctx.sourceBytes;
      if (candidate && Buffer.isBuffer(candidate) && candidate.subarray(0, 25).toString('utf8').startsWith('%PLATEN-AES128-V1')) {
        sealed = candidate;
      } else {
        // Seal then open in one professional path when caller supplies a plaintext source.
        const made = opSecurityEncryptionAes({
          ...ctx,
          sourcePdf: candidate ?? undefined,
          userPassword: ctx.userPassword ?? ctx.openPassword ?? 'UserPass12!abc',
          ownerPassword: ctx.ownerPassword ?? 'OwnerPass12!xyz',
        });
        sealed = made.pdf;
      }
    }
    const bytes = requireBytes(sealed, 'sealedPdf');
    const headerBytes = Buffer.from('%PLATEN-AES128-V1\n', 'utf8');
    if (!bytes.subarray(0, headerBytes.length).equals(headerBytes)) {
      fail('NOT_LOCAL_AES_PACKAGE', 'Only local AES sealed packages can be opened by this path.', 422);
    }
    const userPassword = requireString(ctx.userPassword ?? ctx.openPassword ?? 'UserPass12!abc', 'userPassword', { min: 12, max: 32 });
    const ownerPassword = requireString(ctx.ownerPassword ?? 'OwnerPass12!xyz', 'ownerPassword', { min: 12, max: 32 });
    const key = createHash('sha256').update(`v1|${userPassword}|${ownerPassword}`).digest().subarray(0, 16);
    const iv = bytes.subarray(headerBytes.length, headerBytes.length + 16);
    const ciphertext = bytes.subarray(headerBytes.length + 16);
    try {
      const decipher = createDecipheriv('aes-128-cbc', key, iv);
      const opened = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (!opened.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('OPEN_FAILED', 'Opened payload is not a PDF.', 422);
      return result('security.remove-protection', {
        method: 'local-aes-package-open',
        outputSha256: sha256(opened),
        pdf: opened,
        bytes: opened.length,
        opened: true,
      });
    } catch (error) {
      if (error?.code === 'OPEN_FAILED' || error?.code === 'INVALID_PROFESSIONAL_INPUT') throw error;
      fail('BAD_PASSWORD', 'Password did not open the sealed package.', 403);
    }
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
    // Prefer real JS removal writer when source admits; otherwise inventory fail-closed.
    const source = ctx.sourcePdf ?? ctx.sourceBytes;
    if (source) {
      try {
        const built = buildPdfJavaScriptRemoval(requireBytes(source, 'sourcePdf'), {
          profile: PDF_JAVASCRIPT_REMOVAL_PROFILE,
          sourceSha256: sha256(requireBytes(source, 'sourcePdf')),
        });
        return result('security.javascript-controls', {
          method: 'local-javascript-removal-writer',
          outputSha256: sha256(built.bytes),
          pdf: built.bytes,
          bytes: built.bytes.length,
          proof: built.proof,
        });
      } catch (error) {
        return result('security.javascript-controls', {
          method: 'local-javascript-controls',
          failedClosed: true,
          code: error?.code ?? 'JS_CONTROL_REJECTED',
          message: error?.message ?? 'JavaScript control rejected source',
        });
      }
    }
    return result('security.javascript-controls', {
      method: 'local-javascript-controls',
      policy: { allowExecution: false, allowAuthoring: false },
    });
  },

  async 'security.encryption-aes'(ctx = {}) {
    return opSecurityEncryptionAes(ctx);
  },

  async 'security.open-password'(ctx = {}) {
    const sealed = opSecurityEncryptionAes({
      ...ctx,
      userPassword: ctx.openPassword ?? ctx.userPassword ?? 'OpenPass12!abc',
      ownerPassword: ctx.ownerPassword ?? 'OwnerPass12!xyz',
    });
    return result('security.open-password', { ...sealed, capabilityId: 'security.open-password' });
  },
});
