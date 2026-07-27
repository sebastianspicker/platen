import { structuredTextExport } from '../../../src/core/document-analysis.js';
import { assertInlineOnlyHtml } from '../conversion-admission.mjs';
import { HostError } from '../host-error.mjs';
import { extractFallbackText } from '../office-extractor.mjs';
import { buildPdfCompactRewrite } from '../pdf-compact-rewrite.mjs';
import { cadSourceToPdf } from './cad-geometry.mjs';
import { exportImages } from './create-convert-images.mjs';
import {
  CREATE_CONVERT_CAPABILITY_IDS,
  MAX_CAD_ENTITIES,
  MAX_COMBINE_SOURCES,
  MAX_PAGE_POINTS,
  MIN_PAGE_POINTS,
  blankPdf,
  convertOfficeLike,
  cropPngRegion,
  digest,
  exportOoxml,
  extractPostScriptText,
  factoryFromContext,
  linearizeLocalPdf,
  pageTextArray,
  pagesFromText,
  pdfHeaderOk,
  pngBytesToPdf,
  requireBuffer,
  result,
  sourcePdfBytes
} from './create-convert-lib.mjs';

const handlers = Object.freeze({
  async 'create.blank-pdf'(context = {}) {
    const factory = factoryFromContext(context);
    if (typeof context?.conversion?.createBlank === 'function') {
      const document = await context.conversion.createBlank({
        pages: context.pages ?? 1,
        widthPoints: context.widthPoints ?? 612,
        heightPoints: context.heightPoints ?? 792,
        title: context.title ?? 'Untitled',
      });
      return result('create.blank-pdf', {
        documentId: document.id,
        pageCount: document.operation?.validation?.pageCount ?? context.pages ?? 1,
        size: document.size,
        sha256: document.sha256,
        mediaType: 'application/pdf',
      });
    }
    const pdf = blankPdf(context, factory);
    return result('create.blank-pdf', pdf);
  },

  async 'convert.office-to-pdf'(context = {}) {
    const factory = factoryFromContext(context);
    return convertOfficeLike(
      { ...context, capabilityId: 'convert.office-to-pdf' },
      factory,
      { kind: 'office', title: context.title ?? 'Office conversion' },
    );
  },

  async 'convert.images-to-pdf'(context = {}) {
    if (typeof context?.conversion?.convertInput === 'function' && context?.assetId) {
      const document = await context.conversion.convertInput(context.assetId, { signal: context.signal });
      return result('convert.images-to-pdf', {
        documentId: document.id,
        pageCount: document.operation?.validation?.pageCount ?? 1,
        size: document.size,
        sha256: document.sha256,
        operationType: document.operation?.type,
        mediaType: 'application/pdf',
      });
    }
    const source = requireBuffer(context?.sourceBytes ?? context?.pngBytes, 'sourceBytes');
    const pdf = pngBytesToPdf(source, { title: context.title ?? 'Image conversion' });
    return result('convert.images-to-pdf', { ...pdf, path: 'local-png-xobject' });
  },

  async 'convert.html-to-pdf'(context = {}) {
    const factory = factoryFromContext(context);
    return convertOfficeLike(
      { ...context, capabilityId: 'convert.html-to-pdf', extension: context.extension ?? '.html' },
      factory,
      { kind: 'html', title: context.title ?? 'HTML conversion' },
    );
  },

  async 'create.clipboard-to-pdf'(context = {}) {
    const factory = factoryFromContext(context);
    if (context?.consent !== true && context?.consent !== undefined) {
      throw new HostError('CLIPBOARD_CONSENT_REQUIRED', 'Clipboard-to-PDF requires explicit local consent.', 403);
    }
    if (typeof context?.conversion?.createText === 'function' && context?.text != null) {
      const document = await context.conversion.createText({
        text: String(context.text),
        title: context.title ?? 'Clipboard',
      });
      return result('create.clipboard-to-pdf', {
        documentId: document.id,
        pageCount: 1,
        size: document.size,
        sha256: document.sha256,
        mediaType: 'application/pdf',
      });
    }
    const text = String(context?.text ?? context?.clipboardText ?? '');
    const pdf = pagesFromText(text, { title: context.title ?? 'Clipboard' }, factory);
    return result('create.clipboard-to-pdf', { ...pdf, consent: context?.consent !== false });
  },

  async 'create.print-to-pdf'(context = {}) {
    const factory = factoryFromContext(context);
    // Local print integration: accepted payload is page text (or prebuilt PDF bytes).
    if (Buffer.isBuffer(context?.pdfBytes) && pdfHeaderOk(context.pdfBytes)) {
      return result('create.print-to-pdf', {
        bytes: context.pdfBytes,
        pageCount: context.pageCount ?? 1,
        size: context.pdfBytes.length,
        sha256: digest(context.pdfBytes),
        mediaType: 'application/pdf',
        path: 'print-spool-pdf',
      });
    }
    const pages = Array.isArray(context?.pages)
      ? context.pages.map((page) => String(page?.text ?? page ?? ''))
      : [String(context?.text ?? 'Local print output')];
    const bytes = factory.createTextPdf({
      pages,
      title: context.title ?? 'Print to PDF',
      widthPoints: context.widthPoints ?? 612,
      heightPoints: context.heightPoints ?? 792,
    });
    return result('create.print-to-pdf', {
      bytes,
      pageCount: pages.length,
      size: bytes.length,
      sha256: digest(bytes),
      mediaType: 'application/pdf',
      path: 'local-print-payload',
    });
  },

  async 'create.postscript-to-pdf'(context = {}) {
    const factory = factoryFromContext(context);
    if (typeof context?.conversion?.convertInput === 'function' && context?.assetId) {
      const document = await context.conversion.convertInput(context.assetId, { signal: context.signal });
      return result('create.postscript-to-pdf', {
        documentId: document.id,
        pageCount: document.operation?.validation?.pageCount ?? 1,
        size: document.size,
        sha256: document.sha256,
        operationType: document.operation?.type,
        mediaType: 'application/pdf',
      });
    }
    const source = requireBuffer(context?.sourceBytes ?? context?.inputBytes, 'sourceBytes');
    const text = extractPostScriptText(source);
    const pdf = pagesFromText(text, { title: context.title ?? 'PostScript conversion' }, factory);
    return result('create.postscript-to-pdf', { ...pdf, path: 'local-ps-show-subset' });
  },

  async 'create.multiformat-combine'(context = {}) {
    const factory = factoryFromContext(context);
    const sources = Array.isArray(context?.sources) ? context.sources : null;
    if (!sources || sources.length === 0 || sources.length > MAX_COMBINE_SOURCES) {
      throw new HostError(
        'INVALID_MULTIFORMAT_SOURCES',
        `Multiformat combine requires 1–${MAX_COMBINE_SOURCES} local sources.`,
        400,
      );
    }
    const pageTexts = [];
    for (const source of sources) {
      const kind = String(source?.kind ?? 'text');
      const bytes = requireBuffer(source?.bytes ?? source?.sourceBytes, 'source.bytes');
      if (kind === 'pdf' && pdfHeaderOk(bytes)) {
        pageTexts.push(source.label ? `[PDF ${source.label}]` : '[PDF source]');
        continue;
      }
      if (kind === 'image' || kind === 'png') {
        const imagePdf = pngBytesToPdf(bytes, { title: source.label ?? 'image' });
        pageTexts.push(`[Image ${imagePdf.width}x${imagePdf.height} → PDF ${imagePdf.sha256.slice(0, 12)}]`);
        continue;
      }
      if (kind === 'html') {
        assertInlineOnlyHtml(bytes);
        pageTexts.push(extractFallbackText(bytes, '.html'));
        continue;
      }
      if (kind === 'office' || kind === 'text') {
        const extension = String(source.extension ?? '.txt');
        pageTexts.push(extractFallbackText(bytes, extension));
        continue;
      }
      if (kind === 'postscript' || kind === 'ps') {
        pageTexts.push(extractPostScriptText(bytes));
        continue;
      }
      if (kind === 'cad') {
        const cad = cadSourceToPdf(bytes, { title: source.label ?? 'CAD' });
        pageTexts.push(`[CAD entities=${cad.entityCount} digest=${cad.sha256.slice(0, 12)}]`);
        continue;
      }
      pageTexts.push(bytes.toString('utf8'));
    }
    const bytes = factory.createTextPdf({
      pages: pageTexts,
      title: context.title ?? 'Multiformat combine',
    });
    return result('create.multiformat-combine', {
      bytes,
      pageCount: pageTexts.length,
      size: bytes.length,
      sha256: digest(bytes),
      mediaType: 'application/pdf',
      sourceCount: sources.length,
      path: 'local-multiformat-pages',
    });
  },

  async 'create.cad-to-pdf'(context = {}) {
    if (typeof context?.conversion?.convertInput === 'function' && context?.assetId) {
      try {
        const document = await context.conversion.convertInput(context.assetId, { signal: context.signal });
        return result('create.cad-to-pdf', {
          documentId: document.id,
          pageCount: document.operation?.validation?.pageCount ?? 1,
          size: document.size,
          sha256: document.sha256,
          operationType: document.operation?.type,
          mediaType: 'application/pdf',
        });
      } catch (error) {
        if (error?.code === 'ENGINE_NOT_FOUND' || error?.code === 'ENGINE_UNKNOWN') {
          // Fall through to pure local CAD subset.
        } else {
          throw error;
        }
      }
    }
    const source = requireBuffer(context?.sourceBytes ?? context?.inputBytes, 'sourceBytes');
    const pdf = cadSourceToPdf(source, {
      title: context.title ?? 'CAD conversion',
      widthPoints: context.widthPoints,
      heightPoints: context.heightPoints,
    });
    return result('create.cad-to-pdf', { ...pdf, path: 'local-cad-subset' });
  },

  async 'export.word'(context = {}) {
    return exportOoxml('export.word', 'word', context);
  },

  async 'export.excel'(context = {}) {
    return exportOoxml('export.excel', 'excel', context);
  },

  async 'export.powerpoint'(context = {}) {
    return exportOoxml('export.powerpoint', 'powerpoint', context);
  },

  async 'export.text-rtf'(context = {}) {
    const pages = pageTextArray(context);
    const format = context?.format === 'text' ? 'text' : 'rtf';
    const exported = structuredTextExport(pages, format, { title: context?.title ?? 'PDF text export' });
    const data = exported.data;
    const bytes = Buffer.from(data, 'utf8');
    return result('export.text-rtf', {
      format: exported.extension === 'rtf' ? 'rtf' : 'text',
      extension: exported.extension,
      mediaType: exported.mediaType,
      bytes,
      data,
      size: bytes.length,
      sha256: digest(bytes),
      pageCount: pages.length,
      path: 'structuredTextExport',
    });
  },

  async 'export.html-xml'(context = {}) {
    const pages = pageTextArray(context);
    const format = context?.format === 'xml' ? 'xml' : 'html';
    const exported = structuredTextExport(pages, format, { title: context?.title ?? 'PDF export' });
    const data = exported.data;
    const bytes = Buffer.from(data, 'utf8');
    return result('export.html-xml', {
      format,
      extension: exported.extension,
      mediaType: exported.mediaType,
      bytes,
      data,
      size: bytes.length,
      sha256: digest(bytes),
      pageCount: pages.length,
      path: 'structuredTextExport',
    });
  },

  async 'export.images'(context = {}) { return exportImages(context); },

  async 'export.selected-region'(context = {}) {
    if (typeof context?.service?.renderCropBoxSnapshot === 'function' && context?.documentId) {
      const png = await context.service.renderCropBoxSnapshot(context.documentId, {
        page: context.page ?? 1,
        dpi: context.dpi ?? 72,
        region: context.region,
        signal: context.signal,
      });
      if (!Buffer.isBuffer(png) || png.length < 8) {
        throw new HostError('INVALID_ENGINE_OUTPUT', 'Selected-region export did not return PNG bytes.', 502);
      }
      return result('export.selected-region', {
        bytes: png,
        size: png.length,
        sha256: digest(png),
        mediaType: 'image/png',
        page: context.page ?? 1,
        path: 'renderCropBoxSnapshot',
      });
    }
    const source = requireBuffer(context?.pngBytes ?? context?.sourceBytes, 'pngBytes');
    const region = context?.region ?? { x: 0, y: 0, width: 1, height: 1 };
    const cropped = cropPngRegion(source, region);
    return result('export.selected-region', {
      ...cropped,
      region,
      path: 'local-png-region-crop',
    });
  },

  async 'optimize.compress'(context = {}) {
    const factory = factoryFromContext(context);
    if (typeof context?.conversion?.rewriteDocument === 'function' && context?.documentId) {
      const document = await context.conversion.rewriteDocument(context.documentId, 'optimize', {
        signal: context.signal,
      });
      return result('optimize.compress', {
        documentId: document.id,
        pageCount: document.operation?.validation?.pageCount,
        size: document.size,
        sha256: document.sha256,
        operationType: document.operation?.type,
        mediaType: 'application/pdf',
      });
    }
    const source = sourcePdfBytes(context, factory);
    const rewritten = buildPdfCompactRewrite(source);
    return result('optimize.compress', {
      bytes: rewritten.bytes,
      size: rewritten.bytes.length,
      sha256: digest(rewritten.bytes),
      pageCount: context.pageCount ?? 1,
      mediaType: 'application/pdf',
      reachableObjectCount: rewritten.summary.reachableObjectCount,
      sourceSha256: digest(source),
      path: 'buildPdfCompactRewrite',
    });
  },

  async 'optimize.fast-web-view'(context = {}) {
    const factory = factoryFromContext(context);
    if (typeof context?.fastWebView?.linearize === 'function' && context?.documentId && context?.sourceSha256) {
      const linearized = await context.fastWebView.linearize(context.documentId, {
        profile: 'local-pdf-fast-web-view-v1',
      }, { sourceSha256: context.sourceSha256, signal: context.signal });
      return result('optimize.fast-web-view', {
        artifactId: linearized.artifact?.id ?? null,
        sourceDigest: linearized.sourceDigest,
        engine: linearized.engine,
        linearized: true,
        mediaType: 'application/pdf',
      });
    }
    const source = sourcePdfBytes(context, factory);
    const linearized = linearizeLocalPdf(source);
    return result('optimize.fast-web-view', { ...linearized, path: 'local-linearize' });
  },
});

export { handlers };
export default handlers;

export { CREATE_CONVERT_CAPABILITY_IDS };
