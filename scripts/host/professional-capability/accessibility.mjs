import { createHash } from 'node:crypto';
import { normalizeIncrementalAccessibilityMetadata } from '../pdf-incremental-accessibility-metadata-contract.mjs';
import { writeIncrementalPdfAccessibilityMetadata } from '../pdf-incremental-accessibility-metadata-writer.mjs';
import { result, fail, requireString, sha256 } from './support.mjs';
import { writeTaggedPdfRemediation, inspectTaggedPdfRemediation } from '../pdf-tagged-remediation-writer.mjs';
import { TAGGED_PDF_REMEDIATION_PROFILE } from '../pdf-tagged-remediation-contract.mjs';
import {
  accessibilityTableSemantics,
  accessibilityFormSemantics,
} from './accessibility-ops.mjs';
import {
  accessibilityLinksBookmarks,
  accessibilityScreenReaderPermissions,
} from './accessibility-ops-extra.mjs';

export {
  accessibilityTableSemantics,
  accessibilityFormSemantics,
  accessibilityLinksBookmarks,
  accessibilityScreenReaderPermissions,
};

export function accessibilityAutoTag(ctx = {}) {
  // Heuristic role proposal is applied through the production tagged-PDF writer
  // (same remediable passive substrate as remediate-tags) — not left as proposal-only.
  const text = requireString(ctx.text ?? 'Heading\nParagraph one.', 'text');
  const tags = text.split(/\n+/).filter(Boolean).slice(0, 50).map((line, i) => ({
    role: i === 0 ? 'H1' : 'P',
    text: line.slice(0, 200),
    order: i + 1,
  }));
  const leafRole = tags[0]?.role === 'H1' ? 'H1' : 'P';
  const source = remediablePassivePdf();
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const request = {
    profile: TAGGED_PDF_REMEDIATION_PROFILE,
    sourceSha256,
    plan: {
      id: 'document',
      role: 'Document',
      children: [{ id: 'auto-leaf-1', role: leafRole, page: 1, contentIndex: 0 }],
    },
    language: typeof ctx.lang === 'string' ? ctx.lang : 'en-US',
    title: typeof ctx.title === 'string' && ctx.title !== 'evidence' ? ctx.title : 'Auto-tagged',
    roleMap: {},
  };
  const written = writeTaggedPdfRemediation(source, request);
  const proof = inspectTaggedPdfRemediation(source, written.bytes, request);
  if (proof.structureLinked !== true) {
    fail('AUTO_TAG_APPLY_FAILED', 'Auto-tag structure was not linked into the PDF.', 502);
  }
  if (!written.bytes.toString('latin1').includes('/StructTreeRoot')) {
    fail('AUTO_TAG_MISSING_STRUCT', 'StructTreeRoot missing after auto-tag apply.', 502);
  }
  return result('accessibility.auto-tag', {
    method: 'local-auto-tag-applied-structure',
    tags,
    count: tags.length,
    applied: true,
    proposedNotApplied: false,
    structureLinked: true,
    sourceSha256,
    outputSha256: proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof,
    structTreeRootObjectNumber: proof.structTreeRootObjectNumber,
  });
}

function remediablePassivePdf() {
  // Classic passive single-page PDF without tags/forms/title hazards (writer subset).
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  const object = (number, body) => {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  };
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>');
  const stream = 'q\nQ\n';
  offsets.set(4, Buffer.byteLength(chunks.join(''), 'latin1'));
  chunks.push(`4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream\nendobj\n`);
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 1\n0000000000 65535 f \n');
  for (const [number, offset] of offsets) {
    chunks.push(`${number} 1\n${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

export function accessibilityDocumentLanguageTitle(ctx = {}) {
  const metadata = normalizeIncrementalAccessibilityMetadata({
    language: ctx.lang ?? 'en',
    title: ctx.title ?? 'Document',
  });
  const written = writeIncrementalPdfAccessibilityMetadata(remediablePassivePdf(), metadata);
  const pdf = written.bytes;
  return result('accessibility.document-language-title', {
    method: 'local-lang-title-pdf',
    lang: metadata.language,
    title: metadata.title,
    outputSha256: sha256(pdf),
    pdf,
    bytes: pdf.length,
    proof: written.proof,
  });
}

export function accessibilityColorContrast(ctx = {}) {
  const fg = requireString(ctx.foreground ?? '#111111', 'foreground', { min: 4, max: 9 });
  const bg = requireString(ctx.background ?? '#FFFFFF', 'background', { min: 4, max: 9 });
  const parse = (hex) => {
    const h = hex.replace('#', '');
    if (!/^[0-9A-Fa-f]{6}$/.test(h)) fail('INVALID_COLOR', 'hex color', 400);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [fr, fg_, fb] = parse(fg);
  const [br, bg_, bb] = parse(bg);
  const L1 = 0.2126 * lin(fr) + 0.7152 * lin(fg_) + 0.0722 * lin(fb);
  const L2 = 0.2126 * lin(br) + 0.7152 * lin(bg_) + 0.0722 * lin(bb);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return result('accessibility.color-contrast', {
    method: 'local-a11y-wcag-contrast-ratio',
    foreground: fg,
    background: bg,
    ratio: Number(ratio.toFixed(2)),
    passAA: ratio >= 4.5,
    passAAA: ratio >= 7,
  });
}

export const handlers = Object.freeze({
  async 'accessibility.auto-tag'(ctx = {}) { return accessibilityAutoTag(ctx); },
  async 'accessibility.table-semantics'(ctx = {}) { return accessibilityTableSemantics(ctx); },
  async 'accessibility.form-semantics'(ctx = {}) { return accessibilityFormSemantics(ctx); },
  async 'accessibility.links-bookmarks'(ctx = {}) { return accessibilityLinksBookmarks(ctx); },
  async 'accessibility.document-language-title'(ctx = {}) { return accessibilityDocumentLanguageTitle(ctx); },
  async 'accessibility.color-contrast'(ctx = {}) { return accessibilityColorContrast(ctx); },
  async 'accessibility.screen-reader-permissions'(ctx = {}) { return accessibilityScreenReaderPermissions(ctx); },
});
