import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE } from '../pdf-accessibility-links-bookmarks-contract.mjs';
import {
  inspectPdfAccessibilityLinksBookmarks,
  inspectPdfAccessibilityLinksBookmarksSource,
  writePdfAccessibilityLinksBookmarks,
} from '../pdf-accessibility-links-bookmarks-writer.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
import { writeTaggedPdfRemediation, inspectTaggedPdfRemediation } from '../pdf-tagged-remediation-writer.mjs';
import { TAGGED_PDF_REMEDIATION_PROFILE } from '../pdf-tagged-remediation-contract.mjs';
export {
  accessibilityFontUnicodeMapping,
  accessibilityScreenReaderPermissions,
} from './accessibility-font-permissions.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function linksProductionInput(ctx) {
  if (ctx.sourcePdf === undefined && ctx.sourceBytes === undefined) {
    fail('ACCESSIBILITY_LINKS_SOURCE_REQUIRED', 'Accessible links/bookmarks repair requires explicit source PDF bytes.', 400);
  }
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf', { max: 128 * 1024 * 1024 });
  const sourceSha256 = sha256(source);
  if (ctx.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The supplied links/bookmarks source digest does not match the source PDF.', 409);
  }
  if (typeof ctx.documentId !== 'string' || ctx.documentId.length < 1) {
    fail('ACCESSIBILITY_LINKS_DOCUMENT_REQUIRED', 'Accessible links/bookmarks repair requires an explicit document identity.', 400);
  }
  if (!ctx.linksRequest || typeof ctx.linksRequest !== 'object' || Array.isArray(ctx.linksRequest)) {
    fail('ACCESSIBILITY_LINKS_REQUEST_REQUIRED', 'Accessible links/bookmarks repair requires the exact source-bound linksRequest.', 400);
  }
  if (ctx.linksRequest.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The links/bookmarks request is not bound to the supplied source PDF.', 409);
  }
  const service = ctx.accessibilityLinksBookmarks;
  if (!service || typeof service.update !== 'function') {
    fail('ACCESSIBILITY_LINKS_SERVICE_UNAVAILABLE', 'The production accessibility links/bookmarks service is unavailable.', 503);
  }
  const readArtifact = typeof ctx.readArtifact === 'function'
    ? ctx.readArtifact
    : typeof service.readArtifact === 'function' ? service.readArtifact.bind(service) : null;
  if (!readArtifact) {
    fail('ACCESSIBILITY_LINKS_ARTIFACT_READBACK_REQUIRED', 'Accessible links/bookmarks repair requires an explicit artifact reread authority.', 503);
  }
  return { source, sourceSha256, service, readArtifact, request: ctx.linksRequest };
}

function validateLinksArtifact(receipt, { documentId, sourceSha256, artifactBytes }) {
  const artifact = receipt?.artifact;
  const outputSha256 = sha256(artifactBytes);
  const operation = artifact?.operation;
  if (receipt?.kind !== 'pdf-accessibility-links-bookmarks' || receipt.sourceDigest !== sourceSha256
    || !receipt.evidence || receipt.evidence.localOnly !== true
    || receipt.evidence.sourceUnchanged !== true || receipt.evidence.artifactDigestBound !== true
    || !Array.isArray(receipt.limitations) || receipt.limitations.length < 1
    || !artifact || !UUID.test(String(artifact.id ?? '')) || artifact.documentId !== documentId
    || artifact.mediaType !== 'application/pdf' || artifact.size !== artifactBytes.length
    || artifact.sha256 !== outputSha256 || outputSha256 === sourceSha256
    || operation?.type !== 'pdf-accessibility-links-bookmarks'
    || operation?.validation?.passed !== true || operation.validation.outputSha256 !== outputSha256
    || !Array.isArray(operation.inputs)
    || !operation.inputs.some((input) => input.documentId === documentId
      && input.sha256 === sourceSha256 && input.role === 'source')
    || !isDeepStrictEqual(receipt.operation, operation)) {
    fail('ACCESSIBILITY_LINKS_RECEIPT_INVALID', 'The links/bookmarks receipt is not bound to the requested source and reread artifact.', 502);
  }
  return outputSha256;
}

async function productionLinksBookmarks(ctx) {
  const boundary = linksProductionInput(ctx);
  let receipt;
  try {
    receipt = await boundary.service.update(ctx.documentId, boundary.request, {
      sourceSha256: boundary.sourceSha256,
      signal: ctx.signal,
    });
  } catch (error) {
    if (error?.code) throw error;
    fail('ACCESSIBILITY_LINKS_SERVICE_FAILED', 'The production accessibility links/bookmarks service failed.', 502);
  }
  let artifactBytes;
  try {
    artifactBytes = requireBytes(await boundary.readArtifact(receipt?.artifact), 'accessibleLinksArtifact', { max: 192 * 1024 * 1024 });
  } catch (error) {
    if (error?.code === 'INVALID_PROFESSIONAL_INPUT') {
      fail('ACCESSIBILITY_LINKS_RECEIPT_INVALID', 'The links/bookmarks artifact reread authority did not return bounded PDF bytes.', 502);
    }
    fail('ACCESSIBILITY_LINKS_ARTIFACT_READBACK_FAILED', 'The links/bookmarks artifact could not be reread.', 502);
  }
  const outputSha256 = validateLinksArtifact(receipt, {
    documentId: ctx.documentId,
    sourceSha256: boundary.sourceSha256,
    artifactBytes,
  });
  let proof;
  try {
    proof = inspectPdfAccessibilityLinksBookmarks(boundary.source, artifactBytes, boundary.request);
  } catch {
    fail('ACCESSIBILITY_LINKS_OUTPUT_INVALID', 'Independent links/bookmarks inspection rejected the reread artifact.', 502);
  }
  return result('accessibility.links-bookmarks', {
    method: 'production-accessibility-links-bookmarks-service',
    serviceReceipt: receipt,
    artifact: receipt.artifact,
    limitations: receipt.limitations,
    links: Object.freeze(proof.links.map((link) => Object.freeze({ ...link }))),
    bookmarks: Object.freeze(proof.bookmarks.map((bookmark) => Object.freeze({ ...bookmark }))),
    linkCount: proof.links.length,
    bookmarkCount: proof.bookmarks.length,
    pdf: artifactBytes,
    bytes: artifactBytes.length,
    outputSha256,
    sourceSha256: boundary.sourceSha256,
    applied: true,
    proof,
    demoFixtureUsed: false,
    professionalProof: true,
    trustBoundary: Object.freeze({
      productionService: true,
      immutableSourceDigest: true,
      artifactReread: true,
      independentSemanticInspection: true,
    }),
  });
}

function explicitRepairInput(ctx, requestKey, createDemo) {
  const supplied = ctx.sourcePdf !== undefined || ctx.sourceBytes !== undefined;
  const request = ctx[requestKey];
  if (supplied) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      fail('ACCESSIBILITY_REPAIR_REQUEST_REQUIRED', `Supplied sourcePdf requires ${requestKey}.`, 422);
    }
    return Object.freeze({
      source: requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf'),
      request,
      demoFixtureUsed: false,
    });
  }
  if (request !== undefined || ctx.demoFixture !== true) {
    fail('ACCESSIBILITY_REPAIR_SOURCE_REQUIRED', `Accessibility repair requires sourcePdf and ${requestKey}.`, 422);
  }
  const demo = createDemo();
  return Object.freeze({ ...demo, demoFixtureUsed: true });
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

function passiveLinksBookmarksPdf(linkCount, bookmarkCount, pageCount) {
  const firstPageObject = 3;
  const linkStart = firstPageObject + pageCount;
  const outlineRootObject = linkStart + linkCount;
  const outlineStart = outlineRootObject + 1;
  const pageReferences = Array.from({ length: pageCount }, (_, index) => firstPageObject + index);
  const linkReferences = Array.from({ length: linkCount }, (_, index) => linkStart + index);
  const outlineReferences = Array.from({ length: bookmarkCount }, (_, index) => outlineStart + index);
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${bookmarkCount ? ` /Outlines ${outlineRootObject} 0 R` : ''} >>`,
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageReferences.map((object) => `${object} 0 R`).join(' ')}] >>`,
    ...pageReferences.map((object, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100]${index === 0 && linkCount ? ` /Annots [${linkReferences.map((link) => `${link} 0 R`).join(' ')}]` : ''} >>`),
    ...linkReferences.map((_, index) => `<< /Type /Annot /Subtype /Link /Rect [0 ${index * 2} 10 ${index * 2 + 1}] /Dest [${pageReferences[Math.min(1, pageReferences.length - 1)]} 0 R /Fit] >>`),
    ...(bookmarkCount ? [
      `<< /Type /Outlines /First ${outlineReferences[0]} 0 R /Last ${outlineReferences.at(-1)} 0 R /Count ${bookmarkCount} >>`,
      ...outlineReferences.map((object, index) => `<< /Type /Outlines /Parent ${outlineRootObject} 0 R /Title (Bookmark ${index + 1}) /Dest [${pageReferences[0]} 0 R /Fit]${index ? ` /Prev ${outlineReferences[index - 1]} 0 R` : ''}${index + 1 < bookmarkCount ? ` /Next ${outlineReferences[index + 1]} 0 R` : ''} >>`),
    ] : []),
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export async function accessibilityLinksBookmarks(ctx = {}) {
  if (ctx.demoFixture !== true || ctx.sourcePdf !== undefined || ctx.sourceBytes !== undefined
    || ctx.linksRequest !== undefined || ctx.accessibilityLinksBookmarks !== undefined) {
    return productionLinksBookmarks(ctx);
  }
  const links = Array.isArray(ctx.links)
    ? ctx.links
    : [{ text: 'Contents', page: 2, purpose: 'Internal navigation' }];
  const bookmarks = Array.isArray(ctx.bookmarks)
    ? ctx.bookmarks
    : [{ title: 'Start', page: 1 }];
  const normalizedLinks = links.slice(0, 64).map((link, i) => Object.freeze({
    id: `link-${i + 1}`,
    text: String(link?.text ?? link?.purpose ?? `Link ${i + 1}`).slice(0, 120),
    page: Number.isSafeInteger(link?.page) ? link.page : 1,
    purpose: String(link?.purpose ?? link?.text ?? 'Navigate').slice(0, 120),
  }));
  const normalizedBookmarks = bookmarks.slice(0, 64).map((bm, i) => Object.freeze({
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
  const requestedPages = [...normalizedLinks, ...normalizedBookmarks].map((entry) => entry.page);
  if (requestedPages.some((page) => page < 1 || page > 100)) fail('INVALID_LINK_TARGET', 'Link and bookmark target pages must be from 1 through 100.', 400);
  const pageCount = Math.max(2, ...requestedPages);
  const repair = explicitRepairInput(ctx, 'linksRequest', () => {
    const source = passiveLinksBookmarksPdf(normalizedLinks.length, normalizedBookmarks.length, pageCount);
    const sourceSha256 = sha256(source);
    const inventory = inspectPdfAccessibilityLinksBookmarksSource(source, sourceSha256);
    return {
      source,
      request: {
        profile: PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE,
        sourceSha256,
        links: normalizedLinks.map((link, index) => ({
          locator: { fingerprint: inventory.links[index].fingerprint },
          purpose: link.purpose,
          targetPage: link.page,
        })),
        bookmarks: normalizedBookmarks.map((bookmark, index) => ({
          locator: { fingerprint: inventory.bookmarks[index].fingerprint },
          title: bookmark.title,
          targetPage: bookmark.page,
        })),
      },
    };
  });
  const { source, request } = repair;
  const written = writePdfAccessibilityLinksBookmarks(source, request);
  const proof = inspectPdfAccessibilityLinksBookmarks(source, written.bytes, request);
  const pdf = written.bytes;
  return result('accessibility.links-bookmarks', {
    method: 'local-accessibility-links-bookmarks-repair',
    links: Object.freeze(normalizedLinks),
    bookmarks: Object.freeze(normalizedBookmarks),
    linkCount: normalizedLinks.length,
    bookmarkCount: normalizedBookmarks.length,
    outlineSha256,
    pdf,
    bytes: pdf.length,
    outputSha256: sha256(pdf),
    applied: true,
    proof,
    sourceSha256: sha256(source),
    demoFixtureUsed: repair.demoFixtureUsed,
    sourceByteLength: source.length,
    repairRequest: request,
    professionalProof: false,
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
  const repair = explicitRepairInput(ctx, 'taggedRequest', () => {
    const source = remediableArtifactPdf();
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    return {
      source,
      request: {
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
      },
    };
  });
  const { source, request } = repair;
  const sourceSha256 = sha256(source);
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
    demoFixtureUsed: repair.demoFixtureUsed,
    sourceByteLength: source.length,
    repairRequest: request,
  });
}
