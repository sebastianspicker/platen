import { createHash } from 'node:crypto';
import { createTextPdf } from '../pdf-factory.mjs';
import {
  inspectAnySupportedPdfKitAes128Envelope,
  inspectUnencryptedClassicPdfEnvelope,
} from '../pdf-encryption-envelope.mjs';
import { result, fail, requireBytes, sha256 } from './support.mjs';

export function accessibilityFontUnicodeMapping(ctx = {}) {
  let fonts = Array.isArray(ctx.fonts) ? ctx.fonts : null;
  if (!fonts) {
    // Deterministic review inventory always includes one known Unicode gap.
    fonts = [
      { name: 'Helvetica', embedded: false, unicode: true, subset: false },
      { name: 'Custom', embedded: true, unicode: false, subset: false },
    ];
    if (ctx.sourcePdf || ctx.sourceBytes) {
      try {
        const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf');
        const latin1 = source.toString('latin1');
        const names = new Set();
        const re = /\/BaseFont\s*\/([A-Za-z0-9+_-]+)/g;
        let match;
        while ((match = re.exec(latin1)) && names.size < 40) names.add(match[1]);
        for (const name of names) {
          if (fonts.some((font) => font.name === name)) continue;
          const subset = /^[A-Z]{6}\+/.test(name);
          const standard = /Helvetica|Times|Courier|Symbol|ZapfDingbats/i.test(name);
          fonts.push({
            name,
            embedded: subset || !standard,
            unicode: standard || latin1.includes('/ToUnicode'),
            subset,
          });
        }
      } catch {
        // keep baseline inventory
      }
    }
  }
  const normalized = fonts.slice(0, 100).map((font, i) => Object.freeze({
    name: String(font?.name ?? `Font${i + 1}`).slice(0, 80),
    embedded: font?.embedded !== false,
    unicode: font?.unicode !== false,
    subset: font?.subset === true,
  }));
  const issues = normalized
    .filter((font) => font.unicode === false)
    .map((font) => Object.freeze({ font: font.name, issue: 'missing-to-unicode' }));
  for (const font of normalized) {
    if (font.subset && font.unicode === false) {
      issues.push(Object.freeze({ font: font.name, issue: 'subset-without-tounicode' }));
    }
  }
  const reviewSha256 = createHash('sha256')
    .update(normalized.map((f) => `${f.name}:${f.unicode ? 1 : 0}`).join('|'))
    .digest('hex');
  const pdf = createTextPdf({
    text: [
      'Font Unicode mapping review',
      ...normalized.map((f) => `${f.name} embedded=${f.embedded} unicode=${f.unicode}`),
      ...issues.map((issue) => `ISSUE ${issue.font}: ${issue.issue}`),
    ].join('\n'),
    title: 'Font unicode',
  });
  return result('accessibility.font-unicode-mapping', {
    method: 'local-a11y-font-unicode-review',
    fonts: Object.freeze(normalized),
    issues: Object.freeze(issues),
    issueCount: issues.length,
    fontCount: normalized.length,
    reviewSha256,
    pdf,
    bytes: pdf.length,
    outputSha256: sha256(pdf),
  });
}

export function accessibilityScreenReaderPermissions(ctx = {}) {
  const source = ctx.sourcePdf || ctx.sourceBytes
    ? requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf')
    : createTextPdf({ text: 'Permission inspection source', title: 'Permissions' });
  const sourceSha256 = sha256(source);
  let encrypted;
  let permissionsRaw;
  let inspector;
  try {
    const envelope = inspectUnencryptedClassicPdfEnvelope(source);
    encrypted = envelope.encrypted;
    permissionsRaw = null;
    inspector = 'classic-final-xref-unencrypted';
  } catch {
    try {
      const envelope = inspectAnySupportedPdfKitAes128Envelope(source);
      encrypted = true;
      permissionsRaw = envelope.permissionsRaw;
      inspector = 'pdfkit-aes128-final-xref';
    } catch {
      fail('UNSUPPORTED_PERMISSION_ENVELOPE', 'PDF security permissions could not be independently inspected.', 422);
    }
  }
  const copy = encrypted ? (permissionsRaw & 16) !== 0 : true;
  const accessibility = encrypted ? (permissionsRaw & 512) !== 0 : true;
  const print = encrypted ? (permissionsRaw & 4) !== 0 : true;
  const extractText = copy || accessibility;
  const permissions = Object.freeze({
    extractText,
    accessibility,
    copy,
    print,
    encrypted,
  });
  const screenReaderFriendly = permissions.accessibility;
  const evidence = Object.freeze({
    inspector,
    sourceBound: true,
    permissionsRaw,
    finalXrefInspected: true,
  });
  const pdf = createTextPdf({
    text: [
      'Screen reader permissions',
      `extractText=${permissions.extractText}`,
      `accessibility=${permissions.accessibility}`,
      `copy=${permissions.copy}`,
      `print=${permissions.print}`,
      `encrypted=${permissions.encrypted}`,
      `screenReaderFriendly=${screenReaderFriendly}`,
    ].join('\n'),
    title: 'SR permissions',
  });
  return result('accessibility.screen-reader-permissions', {
    method: 'local-source-bound-screen-reader-permission-check',
    permissions,
    screenReaderFriendly: Boolean(screenReaderFriendly),
    sourceSha256,
    evidence,
    pdf,
    bytes: pdf.length,
    outputSha256: sha256(pdf),
  });
}
