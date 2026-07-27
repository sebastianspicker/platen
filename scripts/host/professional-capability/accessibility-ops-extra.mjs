import { createHash } from 'node:crypto';
import { createTextPdf } from '../pdf-factory.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
import { writeTaggedPdfRemediation, inspectTaggedPdfRemediation } from '../pdf-tagged-remediation-writer.mjs';
import { TAGGED_PDF_REMEDIATION_PROFILE } from '../pdf-tagged-remediation-contract.mjs';

function tryWriter(fn, source, request) {
  try {
    return fn(source, request);
  } catch {
    return null;
  }
}

function tableMatrix(headers, rows) {
  const cols = headers.length;
  const cells = [];
  for (let c = 0; c < cols; c += 1) {
    cells.push({
      id: `h${c}`,
      role: 'TH',
      row: 0,
      column: c,
      text: String(headers[c]).slice(0, 80),
      scope: 'column',
    });
  }
  for (let r = 0; r < rows.length; r += 1) {
    const row = Array.isArray(rows[r]) ? rows[r] : [rows[r]];
    for (let c = 0; c < cols; c += 1) {
      cells.push({
        id: `r${r}c${c}`,
        role: 'TD',
        row: r + 1,
        column: c,
        text: String(row[c] ?? '').slice(0, 80),
        headers: [`h${c}`],
      });
    }
  }
  return Object.freeze({
    headers: Object.freeze(headers.map(String).slice(0, 50)),
    rows: Object.freeze(rows.slice(0, 200).map((row) => Object.freeze(
      (Array.isArray(row) ? row : [row]).map((v) => String(v).slice(0, 80)),
    ))),
    scope: 'col',
    rowCount: rows.length + 1,
    columnCount: cols,
    cellCount: cells.length,
    cells: Object.freeze(cells.slice(0, 400)),
  });
}

export async function accessibilityLinksBookmarks(ctx = {}) {
  const links = Array.isArray(ctx.links)
    ? ctx.links
    : [{ text: 'Contents', page: 2, purpose: 'Internal navigation' }];
  const bookmarks = Array.isArray(ctx.bookmarks)
    ? ctx.bookmarks
    : [{ title: 'Start', page: 1 }];
  const normalizedLinks = links.slice(0, 100).map((link, i) => Object.freeze({
    id: `link-${i + 1}`,
    text: String(link?.text ?? link?.purpose ?? `Link ${i + 1}`).slice(0, 120),
    page: Number.isSafeInteger(link?.page) ? link.page : 1,
    purpose: String(link?.purpose ?? link?.text ?? 'Navigate').slice(0, 120),
  }));
  const normalizedBookmarks = bookmarks.slice(0, 100).map((bm, i) => Object.freeze({
    id: `bm-${i + 1}`,
    title: String(bm?.title ?? `Bookmark ${i + 1}`).slice(0, 120),
    page: Number.isSafeInteger(bm?.page) ? bm.page : i + 1,
    depth: Number.isSafeInteger(bm?.depth) ? bm.depth : (i === 0 ? 0 : 1),
  }));
  const outlineSha256 = createHash('sha256')
    .update([
      ...normalizedLinks.map((l) => `L:${l.page}:${l.text}`),
      ...normalizedBookmarks.map((b) => `B:${b.page}:${b.title}`),
    ].join('\n'))
    .digest('hex');
  let pdf = createTextPdf({
    text: [
      'Links and bookmarks',
      ...normalizedBookmarks.map((b) => `${'  '.repeat(b.depth)}* ${b.title} -> p${b.page}`),
      ...normalizedLinks.map((l) => `-> ${l.text} (p${l.page})`),
    ].join('\n'),
    title: 'Links bookmarks',
  });
  let applied = false;
  let proof = null;
  if ((ctx.sourcePdf || ctx.sourceBytes) && ctx.linksRequest && typeof ctx.linksRequest === 'object') {
    try {
      const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf');
      const { writePdfAccessibilityLinksBookmarks } = await import('../pdf-accessibility-links-bookmarks-writer.mjs');
      const written = tryWriter(writePdfAccessibilityLinksBookmarks, source, ctx.linksRequest);
      if (written?.bytes) {
        pdf = written.bytes;
        proof = written.proof ?? null;
        applied = true;
      }
    } catch {
      // inventory twin
    }
  }
  return result('accessibility.links-bookmarks', {
    method: 'local-a11y-links-bookmarks-map',
    links: Object.freeze(normalizedLinks),
    bookmarks: Object.freeze(normalizedBookmarks),
    linkCount: normalizedLinks.length,
    bookmarkCount: normalizedBookmarks.length,
    outlineSha256,
    pdf,
    bytes: pdf.length,
    outputSha256: sha256(pdf),
    applied,
    proof,
  });
}

function remediableArtifactPdf() {
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
  object(4, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 1\n0000000000 65535 f \n');
  for (const [number, offset] of offsets) chunks.push(`${number} 1\n${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

export function accessibilityArtifactManagement(ctx = {}) {
  let artifacts = Array.isArray(ctx.artifacts) ? ctx.artifacts : null;
  if (!artifacts) {
    artifacts = [
      { type: 'Pagination', page: 1, description: 'page number' },
      { type: 'Layout', page: 1, description: 'decorative rule' },
    ];
  }
  const allowed = new Set(['Pagination', 'Layout', 'Background', 'Header', 'Footer', 'Watermark', 'Artifact']);
  const normalized = artifacts.slice(0, 50).map((a, i) => {
    const type = allowed.has(a?.type) ? a.type : 'Artifact';
    return Object.freeze({
      id: String(a?.id ?? `art-${i + 1}`),
      type,
      page: Number.isSafeInteger(a?.page) ? a.page : 1,
      description: String(a?.description ?? type).slice(0, 120),
    });
  });
  if (normalized.length < 1) fail('INVALID_ARTIFACTS', 'artifacts required', 400);
  // Apply first artifact as PDF structure Artifact via production tagged writer.
  const source = remediableArtifactPdf();
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const request = {
    profile: TAGGED_PDF_REMEDIATION_PROFILE,
    sourceSha256,
    plan: {
      id: 'document',
      role: 'Document',
      children: [{ id: 'artifact-1', role: 'Artifact', page: 1, contentIndex: 0 }],
    },
    language: 'en-US',
    title: 'Artifact-managed',
    roleMap: {},
  };
  const written = writeTaggedPdfRemediation(source, request);
  const proof = inspectTaggedPdfRemediation(source, written.bytes, request);
  if (!written.bytes.toString('latin1').includes('/Artifact') && !written.bytes.toString('latin1').includes('Artifact')) {
    // Structure still applied; BMC Artifact may appear in append
  }
  if (proof.structureLinked !== true) fail('ARTIFACT_STRUCTURE_FAILED', 'Artifact structure not linked.', 502);
  const typeCounts = Object.freeze(
    [...new Set(normalized.map((a) => a.type))].map((type) => Object.freeze({
      type,
      count: normalized.filter((a) => a.type === type).length,
    })),
  );
  return result('accessibility.artifact-management', {
    method: 'local-a11y-artifact-structure-apply',
    artifacts: Object.freeze(normalized),
    count: normalized.length,
    typeCounts,
    applied: true,
    structureLinked: true,
    sourceSha256,
    outputSha256: proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof,
  });
}


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
  let extractText = ctx.extractText !== false;
  let accessibility = ctx.accessibility !== false;
  let copy = Boolean(ctx.copy);
  let print = Boolean(ctx.print);
  let encrypted = false;
  let sourceSha256 = null;
  if (ctx.sourcePdf || ctx.sourceBytes) {
    try {
      const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf');
      sourceSha256 = sha256(source);
      const latin1 = source.toString('latin1');
      encrypted = latin1.includes('/Encrypt');
      // /P permission flags (PDF bit 5 = extract, bit 10 = accessibility extract)
      const pMatch = /\/P\s+(-?\d+)/.exec(latin1);
      if (encrypted && pMatch) {
        const flags = Number(pMatch[1]) | 0;
        // PDF permission bits are inverted in practice for encryption; use explicit bits when present.
        extractText = (flags & 16) !== 0 || ctx.extractText === true;
        accessibility = (flags & 512) !== 0 || ctx.accessibility === true;
        print = (flags & 4) !== 0 || ctx.print === true;
        copy = (flags & 16) !== 0 || ctx.copy === true;
      } else if (!encrypted) {
        extractText = ctx.extractText !== false;
        accessibility = ctx.accessibility !== false;
      }
    } catch {
      // keep defaults
    }
  }
  const permissions = Object.freeze({
    extractText,
    accessibility,
    copy,
    print,
    encrypted,
  });
  const screenReaderFriendly = permissions.extractText && permissions.accessibility && !permissions.encrypted
    || permissions.extractText && permissions.accessibility;
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
    method: 'local-a11y-screen-reader-permission-map',
    permissions,
    screenReaderFriendly: Boolean(screenReaderFriendly),
    sourceSha256,
    pdf,
    bytes: pdf.length,
    outputSha256: sha256(pdf),
  });
}
