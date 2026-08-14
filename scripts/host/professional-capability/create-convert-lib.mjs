/**
 * Professional create-convert capability handlers.
 * Pure-local, fail-closed paths wrapping production modules (no reimplementation of catalog claims).
 * Optional context.conversion / context.store / engine adapters are used when present; otherwise
 * deterministic local factory / OOXML / compact-rewrite / raster paths execute.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { structuredTextExport } from '../../../src/core/document-analysis.js';
import { assertInlineOnlyHtml } from '../conversion-admission.mjs';
import { HostError } from '../host-error.mjs';
import { extractFallbackText } from '../office-extractor.mjs';
import { createBlankPdf, createTextPdf, pdfString } from '../pdf-factory.mjs';
import { buildOoxml } from '../pdf-ooxml-export.mjs';
import { decodePng, encodeRgbaPng } from '../raster-png-codec.mjs';

export const CREATE_CONVERT_CAPABILITY_IDS = Object.freeze([
  'create.blank-pdf',
  'convert.office-to-pdf',
  'convert.images-to-pdf',
  'create.clipboard-to-pdf',
  'create.postscript-to-pdf',
  'create.multiformat-combine',
  'export.word',
  'export.excel',
  'export.powerpoint',
  'export.text-rtf',
  'export.html-xml',
  'export.images',
  'export.selected-region',
  'optimize.compress',
  'optimize.fast-web-view',
]);

export const MAX_PAGE_POINTS = 14_400;
export const MIN_PAGE_POINTS = 72;
export const MAX_COMBINE_SOURCES = 32;
const SHA_256_HEX = /^[0-9a-f]{64}$/u;

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireNotCancelled(signal) {
  if (signal?.aborted) {
    throw new HostError('JOB_CANCELLED', 'Image conversion was cancelled.', 499);
  }
}

function requireSourceSha256(value) {
  if (typeof value !== 'string' || !SHA_256_HEX.test(value)) {
    throw new HostError('INVALID_CAPABILITY_INPUT', 'sourceSha256 must be a lower-case SHA-256 hex digest.', 400);
  }
}

export function requireSourceBoundPngBytes(context, { signal } = {}) {
  requireNotCancelled(signal);
  const sourceBytes = requireBuffer(context?.sourceBytes, 'sourceBytes');
  const sourceSha256 = context?.sourceSha256;
  requireSourceSha256(sourceSha256);
  decodePng(sourceBytes); // ensure the payload is a valid bounded PNG.
  const actualSha256 = digest(sourceBytes);
  if (sourceSha256 !== actualSha256) {
    throw new HostError('SOURCE_VERSION_MISMATCH', 'sourceSha256 does not match sourceBytes.', 409);
  }
  return Object.freeze({ sourceBytes, sourceSha256 });
}

export function assertSourceBoundAdapter(document, sourceSha256) {
  const sourceInputs = Array.isArray(document?.operation?.inputs)
    ? document.operation.inputs.filter((entry) => entry?.role === 'source')
    : [];
  const matched = sourceInputs.find((entry) => entry?.sha256 === sourceSha256);
  if (!matched) {
    throw new HostError(
      'SOURCE_VERSION_MISMATCH',
      'The adapter output is not bound to the supplied image source digest.',
      409,
    );
  }
  return true;
}

export function requireBuffer(value, label) {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new HostError('INVALID_CAPABILITY_INPUT', `${label} must be a non-empty Buffer.`, 400);
  }
  return value;
}

export function pdfHeaderOk(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
}

export function result(capabilityId, fields) {
  return Object.freeze({ capabilityId, ok: true, ...fields });
}

export function factoryFromContext(context) {
  return {
    createBlankPdf: context?.createBlankPdf ?? createBlankPdf,
    createTextPdf: context?.createTextPdf ?? createTextPdf,
  };
}

export function pagesFromText(text, { title = 'Converted', widthPoints = 612, heightPoints = 792 } = {}, factory) {
  const bytes = factory.createTextPdf({ text: String(text ?? ''), title, widthPoints, heightPoints });
  if (!pdfHeaderOk(bytes)) {
    throw new HostError('INVALID_ENGINE_OUTPUT', 'Local PDF factory did not produce a PDF.', 502);
  }
  return Object.freeze({
    bytes,
    pageCount: 1,
    size: bytes.length,
    sha256: digest(bytes),
    mediaType: 'application/pdf',
  });
}

export function blankPdf(options, factory) {
  const pages = Number.isSafeInteger(options?.pages) ? options.pages : 1;
  const bytes = factory.createBlankPdf({
    pages,
    widthPoints: options?.widthPoints ?? 612,
    heightPoints: options?.heightPoints ?? 792,
    title: options?.title ?? 'Untitled',
  });
  if (!pdfHeaderOk(bytes)) {
    throw new HostError('INVALID_ENGINE_OUTPUT', 'Local blank PDF factory did not produce a PDF.', 502);
  }
  return Object.freeze({
    bytes,
    pageCount: pages,
    size: bytes.length,
    sha256: digest(bytes),
    mediaType: 'application/pdf',
  });
}

/** Pure-local RGB/RGBA PNG → single-page PDF with an embedded DeviceRGB image XObject. */
export function pngBytesToPdf(pngBytes, { title = 'Image conversion' } = {}) {
  const decoded = decodePng(pngBytes);
  const { width, height, pixels } = decoded;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, o = 0; i < pixels.length; i += 4, o += 3) {
    const alpha = pixels[i + 3] / 255;
    rgb[o] = Math.round(pixels[i] * alpha + 255 * (1 - alpha));
    rgb[o + 1] = Math.round(pixels[i + 1] * alpha + 255 * (1 - alpha));
    rgb[o + 2] = Math.round(pixels[i + 2] * alpha + 255 * (1 - alpha));
  }
  const compressed = deflateSync(rgb);
  // 72 dpi media box in points matching pixel dimensions, clamped to factory limits.
  const widthPoints = Math.min(MAX_PAGE_POINTS, Math.max(MIN_PAGE_POINTS, width));
  const heightPoints = Math.min(MAX_PAGE_POINTS, Math.max(MIN_PAGE_POINTS, height));
  const content = `q\n${widthPoints} 0 0 ${heightPoints} 0 0 cm\n/Im0 Do\nQ\n`;
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPoints} ${heightPoints}] `
    + `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
  );
  objects.push(`<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}endstream`);
  objects.push(
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} `
    + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode `
    + `/Length ${compressed.length} >>\nstream\n`,
  );
  objects.push(`<< /Title (${pdfString(title)}) /Producer (Platen local image conversion) >>`);

  // Object 5 stream body is binary; assemble carefully.
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    if (index === 4) {
      body += `5 0 obj\n${objects[4]}`;
      body = Buffer.concat([
        Buffer.from(body, 'binary'),
        compressed,
        Buffer.from('\nendstream\nendobj\n', 'binary'),
      ]).toString('binary');
    } else {
      const objectNumber = index + 1;
      body += `${objectNumber} 0 obj\n${objects[index]}\nendobj\n`;
    }
  }
  const infoReference = 6;
  const xrefOffset = Buffer.byteLength(body, 'binary');
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) tail += `${String(offset).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoReference} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const bytes = Buffer.concat([Buffer.from(body, 'binary'), Buffer.from(tail, 'binary')]);
  if (!pdfHeaderOk(bytes)) {
    throw new HostError('INVALID_ENGINE_OUTPUT', 'Local image-to-PDF conversion failed.', 502);
  }
  return Object.freeze({
    bytes,
    pageCount: 1,
    size: bytes.length,
    sha256: digest(bytes),
    mediaType: 'application/pdf',
    width,
    height,
  });
}

/** Extract printable text from a narrow PostScript subset: (text) show / showpage. */
export function extractPostScriptText(source) {
  const text = Buffer.isBuffer(source) ? source.toString('latin1') : String(source ?? '');
  if (!text.includes('%!PS')) {
    throw new HostError('INVALID_POSTSCRIPT_INPUT', 'PostScript input must begin with a %!PS header.', 415);
  }
  const shows = [];
  const showPattern = /\((?:\\.|[^\\)])*\)\s*show\b/g;
  let match;
  while ((match = showPattern.exec(text)) !== null) {
    const raw = match[0].slice(1, match[0].lastIndexOf(')'));
    shows.push(raw.replace(/\\([nrt\\()])/g, (_, ch) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\', '(': '(', ')': ')' })[ch] ?? ch));
  }
  if (shows.length === 0) {
    // EPS/PS without text: emit a deterministic marker page so conversion remains real and fail-closed only on bad headers.
    return 'PostScript conversion (no extractable show operators)';
  }
  return shows.join('\n');
}


export function pageTextArray(context) {
  if (Array.isArray(context?.pages) && context.pages.length > 0) {
    return context.pages.map((page, index) => ({
      page: Number.isSafeInteger(page?.page) ? page.page : index + 1,
      text: String(page?.text ?? ''),
    }));
  }
  const text = String(context?.text ?? 'Platen export');
  return [{ page: 1, text }];
}

export function sourcePdfBytes(context, factory) {
  if (Buffer.isBuffer(context?.pdfBytes) && pdfHeaderOk(context.pdfBytes)) return context.pdfBytes;
  if (Buffer.isBuffer(context?.sourcePdf) && pdfHeaderOk(context.sourcePdf)) return context.sourcePdf;
  if (Buffer.isBuffer(context?.sourceBytes) && pdfHeaderOk(context.sourceBytes)) return context.sourceBytes;
  const pages = pageTextArray(context).map((entry) => entry.text);
  return factory.createTextPdf({ pages, title: context?.title ?? 'Source' });
}

export function cropPngRegion(pngBytes, region) {
  const decoded = decodePng(pngBytes);
  const x = Number.isSafeInteger(region?.x) ? region.x : 0;
  const y = Number.isSafeInteger(region?.y) ? region.y : 0;
  const width = Number.isSafeInteger(region?.width) ? region.width : decoded.width;
  const height = Number.isSafeInteger(region?.height) ? region.height : decoded.height;
  if (x < 0 || y < 0 || width < 1 || height < 1
    || x + width > decoded.width || y + height > decoded.height) {
    throw new HostError('INVALID_REGION', 'Selected region must lie inside the source raster bounds.', 400);
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const src = ((y + row) * decoded.width + x) * 4;
    decoded.pixels.copy(pixels, row * width * 4, src, src + width * 4);
  }
  const bytes = encodeRgbaPng({ width, height, pixels });
  return Object.freeze({
    bytes,
    width,
    height,
    size: bytes.length,
    sha256: digest(bytes),
    mediaType: 'image/png',
  });
}

export async function convertOfficeLike(context, factory, { kind, title }) {
  const source = requireBuffer(context?.sourceBytes ?? context?.inputBytes, 'sourceBytes');
  if (kind === 'html') assertInlineOnlyHtml(source);
  if (typeof context?.conversion?.convertInput === 'function' && context?.assetId) {
    const document = await context.conversion.convertInput(context.assetId, { signal: context.signal });
    return result(context.capabilityId, {
      documentId: document.id,
      pageCount: document.operation?.validation?.pageCount ?? 1,
      size: document.size,
      sha256: document.sha256,
      operationType: document.operation?.type,
      mediaType: 'application/pdf',
    });
  }
  const extension = kind === 'html'
    ? '.html'
    : String(context?.extension ?? '.txt').toLowerCase();
  const text = extractFallbackText(source, extension);
  const pdf = pagesFromText(text, { title }, factory);
  return result(context.capabilityId, { ...pdf, extractedTextLength: text.length, path: 'local-text-fallback' });
}

export async function exportOoxml(capabilityId, format, context) {
  if (typeof context?.ooxmlExport?.export === 'function' && context?.documentId && context?.sourceSha256) {
    const exported = await context.ooxmlExport.export(context.documentId, format, {
      sourceSha256: context.sourceSha256,
      signal: context.signal,
    });
    return result(capabilityId, {
      format,
      extension: exported.extension,
      mediaType: exported.mediaType,
      pageCount: exported.pageCount,
      sourceDigest: exported.sourceDigest,
      artifactId: exported.artifact?.id ?? null,
    });
  }
  const pages = pageTextArray(context);
  const built = buildOoxml(format, pages);
  return result(capabilityId, {
    format,
    extension: built.extension,
    mediaType: built.mediaType,
    bytes: built.bytes,
    size: built.bytes.length,
    sha256: digest(built.bytes),
    pageCount: built.pages.length,
    path: 'local-buildOoxml',
  });
}
