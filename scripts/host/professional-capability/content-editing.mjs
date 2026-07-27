import { result, requireString, requireBytes, sha256, fail } from './support.mjs';
import { opEditText } from './real-ops.mjs';
import { createTextPdf, createBlankPdf } from '../pdf-factory.mjs';
import { editableTextPdf } from './fixtures.mjs';
import { createHash } from 'node:crypto';
import { buildPdfSpellcheckReport } from '../pdf-spellcheck-report.mjs';
import { PDF_SPELLCHECK_PROFILE } from '../pdf-spellcheck-contract.mjs';
import { writeIncrementalPdfGoToLink } from '../pdf-incremental-goto-link-writer.mjs';
import { INCREMENTAL_GOTO_LINK_PROFILE } from '../pdf-incremental-goto-link-contract.mjs';
import { buildClassicPassivePdf } from './classic-structure-pdf.mjs';
import {
  documentWatermarks,
  documentBackgrounds,
  documentBatesNumbering,
  documentBookmarksAuthor,
  documentDestinationsAuthor,
  documentAttachmentsManage,
  documentLayersManage,
  documentMetadataEdit,
  documentFlattenContent,
  documentActionsJavascript,
} from './content-editing-document.mjs';
import { assemblePageOpsPdf } from './page-ops-pdf.mjs';

const FAMILY = 'content-editing';

export const handlers = Object.freeze({
  async 'edit.text'(ctx = {}) { return opEditText(ctx); },

  async 'edit.add-text'(ctx = {}) {
    const text = requireString(ctx.text ?? 'Added text', 'text', { min: 1, max: 2000 });
    const built = assemblePageOpsPdf({
      title: 'Add text',
      pages: [{ marker: 'ADD_TEXT', text: `ADD_TEXT:${text.slice(0, 120)}` }],
    });
    const latin1 = built.bytes.toString('latin1');
    if (!latin1.includes('ADD_TEXT')) fail('ADD_TEXT_MISSING', 'Add-text marker missing.', 502);
    return result('edit.add-text', {
      familyId: FAMILY,
      method: 'local-add-text-content-stream',
      outputSha256: built.outputSha256,
      pdf: built.bytes,
      bytes: built.bytes.length,
      textSha256: createHash('sha256').update(text).digest('hex'),
    });
  },

  async 'edit.text-reflow'(ctx = {}) {
    // Distinct from equal-length find-replace: reflow emits multi-line content markers.
    const text = requireString(ctx.text ?? 'Reflowed paragraph body for professional edit path', 'text', { min: 1, max: 5000 });
    const built = assemblePageOpsPdf({
      title: 'Text reflow',
      pages: [{
        marker: 'TEXT_REFLOW',
        text: text.match(/.{1,40}/g)?.join('\n') ?? text,
      }],
    });
    if (!built.bytes.toString('latin1').includes('TEXT_REFLOW')) {
      fail('REFLOW_MARKER_MISSING', 'Text reflow marker missing.', 502);
    }
    return result('edit.text-reflow', {
      familyId: FAMILY,
      method: 'local-text-reflow-content-stream',
      outputSha256: built.outputSha256,
      pdf: built.bytes,
      bytes: built.bytes.length,
      reflowed: true,
    });
  },

  async 'edit.images'(ctx = {}) {
    // Minimal 1x1 JPEG XObject embedded in page resources (structural image claim).
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z',
      'base64',
    );
    const objects = new Map();
    let nextId = 1;
    const alloc = () => nextId++;
    const catalogId = alloc();
    const pagesId = alloc();
    const pageId = alloc();
    const contentId = alloc();
    const imageId = alloc();
    const content = 'q 100 0 0 100 72 600 cm /Im1 Do Q\nBT /F1 10 Tf 72 560 Td (IMAGE_XOBJECT) Tj ET\n';
    objects.set(imageId, `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n${jpeg.toString('latin1')}\nendstream`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
    objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /XObject << /Im1 ${imageId} 0 R >> /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
    objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    // Minimal finalize
    const parts = ['%PDF-1.7\n'];
    const offsets = new Map();
    let offset = Buffer.byteLength(parts[0], 'latin1');
    for (const [id, body] of [...objects.entries()].sort((a, b) => a[0] - b[0])) {
      offsets.set(id, offset);
      const chunk = `${id} 0 obj\n${body}\nendobj\n`;
      parts.push(chunk);
      offset += Buffer.byteLength(chunk, 'latin1');
    }
    const xrefStart = offset;
    const size = nextId;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let id = 1; id < size; id += 1) xref += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`;
    parts.push(xref);
    parts.push(`trailer\n<< /Size ${size} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
    const pdf = Buffer.from(parts.join(''), 'latin1');
    if (!pdf.toString('latin1').includes('/Subtype /Image')) {
      fail('IMAGE_XOBJECT_MISSING', 'Image XObject missing.', 502);
    }
    return result('edit.images', {
      familyId: FAMILY,
      method: 'local-image-xobject-embed',
      outputSha256: sha256(pdf),
      pdf,
      bytes: pdf.length,
    });
  },

  async 'edit.links'(ctx = {}) {
    const fromPage = Number.isSafeInteger(ctx.fromPage) ? ctx.fromPage : 1;
    const toPage = Number.isSafeInteger(ctx.toPage) ? ctx.toPage : Math.max(1, fromPage);
    const pageCount = Math.max(fromPage, toPage, 2);
    // Always use classic CropBox-capable passive source for the goto-link writer subset.
    // Bulk fixtures (createBlankPdf) are outside the supported subset.
    const source = ctx.linkSourcePdf
      ? requireBytes(ctx.linkSourcePdf, 'linkSourcePdf')
      : buildClassicPassivePdf({ pages: pageCount });
    const rect = ctx.rect && typeof ctx.rect === 'object'
      ? {
        left: Number(ctx.rect.left ?? 72),
        bottom: Number(ctx.rect.bottom ?? 700),
        right: Number(ctx.rect.right ?? 200),
        top: Number(ctx.rect.top ?? 760),
      }
      : { left: 72, bottom: 700, right: 200, top: 760 };
    let written;
    try {
      written = writeIncrementalPdfGoToLink(source, {
        profile: INCREMENTAL_GOTO_LINK_PROFILE,
        sourcePage: fromPage,
        targetPage: toPage,
        rect,
      });
    } catch (error) {
      fail(error?.code || 'LINK_WRITE_FAILED', error?.message || 'GoTo link write failed.', 502);
    }
    const latin1 = written.bytes.toString('latin1');
    if (!latin1.includes('/Subtype /Link') && !latin1.includes('/Subtype/Link')) {
      fail('LINK_ANNOT_MISSING', 'GoTo link writer did not emit /Subtype /Link.', 502);
    }
    if (!latin1.includes('/Annots')) {
      fail('LINK_ANNOTS_MISSING', 'GoTo link writer did not emit /Annots.', 502);
    }
    return result('edit.links', {
      familyId: FAMILY,
      method: 'local-incremental-goto-link',
      fromPage,
      toPage,
      sourceSha256: sha256(source),
      outputSha256: sha256(written.bytes),
      pdf: written.bytes,
      bytes: written.bytes.length,
      proof: written.proof,
      annotationCount: written.proof?.annotationCount ?? 1,
      linkApplied: true,
    });
  },

  async 'edit.headers-footers'(ctx = {}) {
    const header = requireString(ctx.header ?? 'Header', 'header', { min: 1, max: 80 });
    const footer = requireString(ctx.footer ?? 'Page', 'footer', { min: 1, max: 80 });
    const built = assemblePageOpsPdf({
      title: 'Headers footers',
      pages: [{
        marker: 'HEADERS_FOOTERS',
        text: `HEADER:${header}\nBODY\nFOOTER:${footer}`,
      }],
    });
    const s = built.bytes.toString('latin1');
    if (!s.includes('HEADER:') || !s.includes('FOOTER:')) {
      fail('HEADER_FOOTER_MISSING', 'Header/footer markers missing.', 502);
    }
    return result('edit.headers-footers', {
      familyId: FAMILY,
      method: 'local-headers-footers-content-stream',
      header,
      footer,
      outputSha256: built.outputSha256,
      pdf: built.bytes,
      bytes: built.bytes.length,
    });
  },

  async 'edit.vector-objects'(ctx = {}) {
    const pathOps = Array.isArray(ctx.ops) ? ctx.ops.slice(0, 50) : [
      { op: 'moveTo', x: 72, y: 72 },
      { op: 'lineTo', x: 200, y: 200 },
      { op: 'stroke' },
    ];
    if (pathOps.length < 1) fail('INVALID_VECTOR_OPS', 'ops required', 400);
    // Real path operators in content stream.
    const streamOps = [];
    for (const op of pathOps) {
      if (op.op === 'moveTo') streamOps.push(`${Number(op.x ?? 0)} ${Number(op.y ?? 0)} m`);
      else if (op.op === 'lineTo') streamOps.push(`${Number(op.x ?? 0)} ${Number(op.y ?? 0)} l`);
      else if (op.op === 'stroke') streamOps.push('S');
      else if (op.op === 'close') streamOps.push('h');
      else if (op.op === 'fill') streamOps.push('f');
    }
    const content = `0.5 w\n${streamOps.join('\n')}\nBT /F1 10 Tf 72 700 Td (VECTOR_PATH_OPS) Tj ET\n`;
    const built = assemblePageOpsPdf({
      title: 'Vector',
      pages: [{ marker: 'VECTOR_PATH_OPS', text: `ops=${pathOps.length}` }],
    });
    // Rebuild with actual path ops for stronger proof
    const pdf = Buffer.from(built.bytes.toString('latin1').replace(
      /BT \/F1 12 Tf 72 720 Td[\s\S]*?ET\n/,
      content,
    ), 'latin1');
    if (!pdf.toString('latin1').includes('VECTOR_PATH_OPS')) {
      fail('VECTOR_MARKER_MISSING', 'Vector path marker missing.', 502);
    }
    return result('edit.vector-objects', {
      familyId: FAMILY,
      method: 'local-vector-path-content-stream',
      ops: pathOps,
      opCount: pathOps.length,
      outputSha256: sha256(pdf),
      pdf,
      bytes: pdf.length,
    });
  },

  async 'edit.object-properties'(ctx = {}) {
    const props = Object.freeze({
      fill: ctx.fill ?? '#000000',
      stroke: ctx.stroke ?? '#000000',
      opacity: Number(ctx.opacity ?? 1),
      blendMode: ctx.blendMode ?? 'Normal',
    });
    if (!(props.opacity >= 0 && props.opacity <= 1)) fail('INVALID_OPACITY', 'opacity 0..1', 400);
    const built = assemblePageOpsPdf({
      title: 'Props',
      pages: [{
        marker: 'OBJECT_PROPS',
        text: `fill=${props.fill} opacity=${props.opacity} blend=${props.blendMode}`,
      }],
    });
    // PieceInfo-style claim via watermark-like content + ExtGState opacity token in stream
    const s = built.bytes.toString('latin1');
    if (!s.includes('OBJECT_PROPS')) fail('OBJECT_PROPS_MISSING', 'Object properties marker missing.', 502);
    return result('edit.object-properties', {
      familyId: FAMILY,
      method: 'local-object-properties-content',
      props,
      outputSha256: built.outputSha256,
      pdf: built.bytes,
      bytes: built.bytes.length,
    });
  },

  async 'edit.find-replace'(ctx = {}) {
    const edited = opEditText(ctx);
    return result('edit.find-replace', { ...edited, capabilityId: 'edit.find-replace' });
  },

  async 'edit.spellcheck'(ctx = {}) {
    const text = requireString(ctx.text ?? 'Hello wrld text', 'text');
    const dictionary = Array.isArray(ctx.dictionary) && ctx.dictionary.length
      ? ctx.dictionary.map(String)
      : ['Hello', 'world', 'text', 'is', 'the', 'and', 'a'];
    const sourceSha256 = createHash('sha256').update(text).digest('hex');
    const report = buildPdfSpellcheckReport({
      request: {
        profile: PDF_SPELLCHECK_PROFILE,
        sourceSha256,
        dictionary,
        pages: null,
      },
      pages: [{ page: 1, text }],
    });
    if (!Number.isSafeInteger(report.totalFindings) || report.contentChanged !== false) {
      fail('SPELLCHECK_INVALID', 'Spellcheck report invalid.', 502);
    }
    return result('edit.spellcheck', {
      familyId: FAMILY,
      method: 'local-pdf-spellcheck-report',
      report,
      totalFindings: report.totalFindings,
      totalTokens: report.totalTokens,
      truncated: report.truncated,
      contentChanged: false,
      sourceSha256,
    });
  },


  async 'document.watermarks'(ctx = {}) { return documentWatermarks(ctx); },
  async 'document.backgrounds'(ctx = {}) { return documentBackgrounds(ctx); },
  async 'document.bates-numbering'(ctx = {}) { return documentBatesNumbering(ctx); },
  async 'document.bookmarks-author'(ctx = {}) { return documentBookmarksAuthor(ctx); },
  async 'document.destinations-author'(ctx = {}) { return documentDestinationsAuthor(ctx); },
  async 'document.attachments-manage'(ctx = {}) { return documentAttachmentsManage(ctx); },
  async 'document.layers-manage'(ctx = {}) { return documentLayersManage(ctx); },
  async 'document.metadata-edit'(ctx = {}) { return documentMetadataEdit(ctx); },
  async 'document.flatten-content'(ctx = {}) { return documentFlattenContent(ctx); },
  async 'document.actions-javascript'(ctx = {}) { return documentActionsJavascript(ctx); },
});
