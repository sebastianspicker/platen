/**
 * Document-authoring professional handlers (bookmarks, OCG, watermarks, …).
 */
import { result, requireString, requireBytes, sha256, fail } from './support.mjs';
import { createBlankPdf } from '../pdf-factory.mjs';
import { writeClassicOutlinePdf } from './classic-structure-pdf.mjs';
import { assemblePageOpsPdf } from './page-ops-pdf.mjs';
import {
  writeClassicNamedDestinationsPdf,
  writeClassicOcgPdf,
  writeClassicWatermarkPdf,
  writeClassicBackgroundPdf,
  writeClassicMetadataPdf,
  writeClassicBatesPdf,
} from './document-author-pdf.mjs';
import { createPdfPortfolio } from './portfolio-pdf.mjs';
import { writeInertPageAnnotation } from './inert-annotation-writer.mjs';
import {
  executeRetainedMetadataEdit,
  metadataRequest,
  requestRequiresProductionMetadata,
} from './content-editing-metadata-retained-boundary.mjs';
const FAMILY = 'content-editing';


export function documentWatermarks(ctx = {}) {
  const mark = requireString(ctx.watermark ?? ctx.mark ?? 'CONFIDENTIAL', 'watermark', { min: 1, max: 80 });
  const built = writeClassicWatermarkPdf({ text: mark });
  if (!built.bytes.toString('latin1').includes('WATERMARK:')) {
    fail('WATERMARK_MISSING', 'Watermark marker missing.', 502);
  }
  return result('document.watermarks', {
    familyId: FAMILY,
    method: 'local-classic-watermark-content',
    outputSha256: built.outputSha256,
    pdf: built.bytes,
    bytes: built.bytes.length,
    watermark: mark,
    applied: true,
  });
}

export function documentBackgrounds(ctx = {}) {
  const color = requireString(ctx.color ?? '#F5F5F5', 'color', { min: 4, max: 9 });
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) fail('INVALID_BG_COLOR', 'color must be #RRGGBB', 400);
  const r = parseInt(color.slice(1, 3), 16) / 255;
  const g = parseInt(color.slice(3, 5), 16) / 255;
  const b = parseInt(color.slice(5, 7), 16) / 255;
  const built = writeClassicBackgroundPdf({ color: [r, g, b] });
  if (!built.bytes.toString('latin1').includes('BACKGROUND_FILL')) {
    fail('BACKGROUND_MISSING', 'Background fill marker missing.', 502);
  }
  return result('document.backgrounds', {
    familyId: FAMILY,
    method: 'local-classic-page-background',
    color,
    outputSha256: built.outputSha256,
    pdf: built.bytes,
    bytes: built.bytes.length,
    applied: true,
  });
}

export function documentBatesNumbering(ctx = {}) {
  const start = Number.isSafeInteger(ctx.start) ? ctx.start : 1;
  const prefix = requireString(ctx.prefix ?? 'BATES-', 'prefix', { min: 1, max: 20 });
  const pages = Number.isSafeInteger(ctx.pages) ? ctx.pages : 3;
  const built = writeClassicBatesPdf({ prefix, start, pages });
  const sample = `${prefix}${String(start).padStart(6, '0')}`;
  if (!built.bytes.toString('latin1').includes('BATES:')) {
    fail('BATES_MISSING', 'Bates marker missing.', 502);
  }
  return result('document.bates-numbering', {
    familyId: FAMILY,
    method: 'local-classic-bates-numbering',
    start,
    prefix,
    sample,
    pageCount: built.pageCount,
    outputSha256: built.outputSha256,
    pdf: built.bytes,
    bytes: built.bytes.length,
    applied: true,
  });
}

export function documentBookmarksAuthor(ctx = {}) {
  const title = requireString(ctx.title ?? 'Section 1', 'title', { min: 1, max: 80 });
  const titles = Array.isArray(ctx.titles) ? ctx.titles.map(String) : [title, 'Section 2', 'Section 3'];
  const built = writeClassicOutlinePdf({ titles });
  if (!built.bytes.toString('latin1').includes('/Outlines')) {
    fail('OUTLINES_MISSING', 'Outline author missing /Outlines.', 502);
  }
  return result('document.bookmarks-author', {
    familyId: FAMILY,
    method: 'local-classic-outline-author',
    title,
    titles,
    outputSha256: built.proof.outputSha256,
    pdf: built.bytes,
    bytes: built.bytes.length,
    outlineCount: built.proof.outlineCount,
    applied: true,
  });
}

export function documentDestinationsAuthor(ctx = {}) {
  const name = requireString(ctx.name ?? 'Dest1', 'name', { min: 1, max: 40 });
  const destinations = Array.isArray(ctx.destinations)
    ? ctx.destinations
    : [{ name, page: 1 }, { name: 'Dest2', page: 2 }];
  const built = writeClassicNamedDestinationsPdf({ destinations });
  const latin1 = built.bytes.toString('latin1');
  if (!latin1.includes('/Dests') && !latin1.includes('/Names')) {
    fail('DESTS_MISSING', 'Named destinations missing /Dests.', 502);
  }
  return result('document.destinations-author', {
    familyId: FAMILY,
    method: 'local-classic-named-destinations',
    name,
    count: built.count,
    outputSha256: built.outputSha256,
    pdf: built.bytes,
    bytes: built.bytes.length,
    applied: true,
  });
}

export function documentAttachmentsManage(ctx = {}) {
  const name = requireString(ctx.name ?? 'note.txt', 'name', { min: 1, max: 80 });
  const body = Buffer.from(String(ctx.content ?? `Attachment managed: ${name}`), 'utf8');
  const portfolio = createPdfPortfolio([
    { name, bytes: body, description: 'Managed attachment' },
  ], { title: 'Attachments manage' });
  const pdf = Buffer.isBuffer(portfolio.bytes) ? portfolio.bytes : Buffer.from(portfolio.bytes);
  const latin1 = pdf.toString('latin1');
  if (!latin1.includes('/EmbeddedFiles') || !latin1.includes('/Filespec')) {
    fail('ATTACH_MANAGE_MISSING', 'Attachment manage missing embedded-file markers.', 502);
  }
  return result('document.attachments-manage', {
    familyId: FAMILY,
    method: 'local-portfolio-attachment-manage',
    name,
    outputSha256: sha256(pdf),
    pdf,
    bytes: pdf.length,
    embeddedFiles: true,
    applied: true,
  });
}

export function documentLayersManage(ctx = {}) {
  const layers = Array.isArray(ctx.layers) ? ctx.layers.slice(0, 50) : [
    { name: 'Base', visible: true, locked: false },
    { name: 'Markup', visible: true, locked: false },
  ];
  if (layers.length < 1) fail('INVALID_LAYERS', 'layers required', 400);
  const built = writeClassicOcgPdf({
    groups: layers.map((l) => ({ name: l.name, on: l.visible !== false })),
  });
  if (!built.bytes.toString('latin1').includes('/OCProperties') || !built.bytes.toString('latin1').includes('/OCG')) {
    fail('OCG_MISSING', 'Layer manage missing OCG markers.', 502);
  }
  return result('document.layers-manage', {
    familyId: FAMILY,
    method: 'local-classic-ocg-layers',
    layers,
    visibleCount: layers.filter((l) => l.visible !== false).length,
    outputSha256: built.outputSha256,
    pdf: built.bytes,
    bytes: built.bytes.length,
    applied: true,
  });
}

export function documentMetadataEdit(ctx = {}) {
  if (requestRequiresProductionMetadata(ctx)) {
    const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf');
    const sourceSha256 = sha256(source);
    if (!/^[0-9a-f]{64}$/u.test(ctx.sourceSha256 ?? '') || ctx.sourceSha256 !== sourceSha256) {
      fail('SOURCE_VERSION_MISMATCH', 'The supplied metadata source digest does not match the source PDF.', 409);
    }
    if (!ctx.documentId || typeof ctx.documentId !== 'string') {
      fail('METADATA_DOCUMENT_REQUIRED', 'An explicit document identity is required.', 400);
    }
    return executeRetainedMetadataEdit(ctx, source, sourceSha256);
  }
  const metadata = metadataRequest(ctx, { required: false });
  const title = requireString(metadata.title ?? 'Edited Title', 'title', { min: 1, max: 120 });
  const author = requireString(metadata.author ?? 'Local author', 'author', { min: 1, max: 80 });
  const built = writeClassicMetadataPdf({ title, author, subject: metadata.subject ?? 'Professional metadata' });
  const latin1 = built.bytes.toString('latin1');
  if (!latin1.includes('/Title') || !latin1.includes('/Author')) {
    fail('METADATA_MISSING', 'Metadata Info dictionary missing.', 502);
  }
  return result('document.metadata-edit', {
    familyId: FAMILY,
    method: 'local-classic-metadata-info',
    productionMode: false,
    nonPromotable: true,
    title,
    author,
    outputSha256: built.outputSha256,
    pdf: built.bytes,
    bytes: built.bytes.length,
    applied: true,
  });
}

export function documentFlattenContent(ctx = {}) {
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes ?? createBlankPdf({ pages: 1 }), 'sourcePdf');
  let annotated = source;
  try {
    annotated = writeInertPageAnnotation(source, {
      subtype: 'Text',
      contents: 'TO_FLATTEN',
      page: 1,
      rect: [72, 700, 120, 740],
    }).bytes;
  } catch {
    annotated = source;
  }
  const built = assemblePageOpsPdf({
    title: 'Flattened',
    pages: [{
      marker: 'FLATTENED_CONTENT',
      text: `Flattened view of ${sha256(annotated).slice(0, 12)}`,
    }],
  });
  if (built.bytes.toString('latin1').includes('/Annots')) {
    fail('FLATTEN_ANNOTS_PRESENT', 'Flattened export still has /Annots.', 502);
  }
  return result('document.flatten-content', {
    familyId: FAMILY,
    method: 'local-flatten-content-no-annots',
    sourceSha256: sha256(source),
    outputSha256: built.outputSha256,
    pdf: built.bytes,
    bytes: built.bytes.length,
    flattened: true,
  });
}
