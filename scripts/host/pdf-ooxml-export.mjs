import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { types as utilTypes } from 'node:util';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { readZipEntries } from './zip-reader.mjs';
import { writeStoredZip, OOXML_ZIP_LIMITS } from './pdf-ooxml-export-zip.mjs';

export const OOXML_EXPORT_LIMITS = Object.freeze({
  maximumPages: 200,
  maximumLinesPerPage: 10_000,
  maximumLineCharacters: 32_768,
  maximumTextBytes: 8 * 1024 * 1024,
  maximumOutputBytes: OOXML_ZIP_LIMITS.maximumArchiveBytes,
});

const FORMAT = Object.freeze({
  word: Object.freeze({ extension: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', display: 'Word' }),
  excel: Object.freeze({ extension: 'xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', display: 'Excel' }),
  powerpoint: Object.freeze({ extension: 'pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', display: 'PowerPoint' }),
});

function fail(code, message, status = 422, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function abort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new HostError('JOB_CANCELLED', 'OOXML export was cancelled.', 499);
}

function exactDataRecord(value, allowedKeys, label, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail('OOXML_TEXT_UNBOUND', `${label} must be a non-proxy data record.`, 502);
  }
  let keys;
  try { keys = Reflect.ownKeys(value); } catch (error) { fail('OOXML_TEXT_UNBOUND', `${label} could not be inspected safely.`, 502, error); }
  const allowed = new Set(allowedKeys);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))
    || requiredKeys.some((key) => !keys.includes(key))) {
    fail('OOXML_TEXT_UNBOUND', `${label} contains unexpected fields.`, 502);
  }
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('OOXML_TEXT_UNBOUND', `${label} contains an accessor field.`, 502);
    values[key] = descriptor.value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('OOXML_TEXT_UNBOUND', `${label} has an unexpected prototype.`, 502);
  return values;
}

function snapshotPages(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) fail('OOXML_TEXT_UNBOUND', 'The extracted page array must be a non-proxy array.', 502);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch (error) { fail('OOXML_TEXT_UNBOUND', 'The extracted page array could not be inspected safely.', 502, error); }
  if (keys.length !== value.length + 1 || !keys.includes('length')) fail('OOXML_TEXT_UNBOUND', 'The extracted page array contains unexpected fields.', 502);
  const pages = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) fail('OOXML_TEXT_UNBOUND', 'The extracted page array contains a hole or unexpected field.', 502);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('OOXML_TEXT_UNBOUND', 'The extracted page array contains an accessor element.', 502);
    const page = exactDataRecord(descriptor.value, ['page', 'text'], 'Extracted page');
    pages.push(Object.freeze({ page: page.page, text: page.text }));
  }
  return Object.freeze(pages);
}

export class OoxmlCleanupError extends AggregateError {
  constructor(errors, message = 'OOXML export cleanup failed.') {
    const cause = new AggregateError(errors, message);
    super(errors, message, { cause });
    this.name = 'OoxmlCleanupError';
    this.code = 'OOXML_CLEANUP_FAILED';
    this.status = 500;
  }
}

function validatePromotedArtifact(artifact, selected, documentId, outputSha256, outputSize) {
  if (!artifact || typeof artifact !== 'object' || utilTypes.isProxy(artifact)
    || typeof artifact.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(artifact.id)
    || artifact.documentId !== documentId || artifact.mediaType !== selected.mediaType || artifact.size !== outputSize
    || artifact.sha256 !== outputSha256 || typeof artifact.displayName !== 'string' || !artifact.displayName.endsWith(`.${selected.extension}`)) {
    fail('OOXML_OUTPUT_INVALID', 'The promoted OOXML artifact does not match the validated output.', 502);
  }
}

function xmlEscape(value) {
  const source = String(value ?? '');
  for (const character of source) {
    const codePoint = character.codePointAt(0);
    const valid = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!valid) fail('INVALID_OOXML_TEXT', 'Extracted text contains a character forbidden by XML 1.0.');
  }
  return source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function textNode(value) {
  const escaped = xmlEscape(value);
  return escaped.length && (/^\s|\s$/u.test(String(value)) ? ` xml:space="preserve"` : '')
    ? `<w:t${/^\s|\s$/u.test(String(value)) ? ' xml:space="preserve"' : ''}>${escaped}</w:t>` : `<w:t>${escaped}</w:t>`;
}

function normalizePages(pages, limits = OOXML_EXPORT_LIMITS) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > limits.maximumPages) {
    fail('INVALID_OOXML_TEXT_PAGES', 'OOXML export requires a non-empty bounded page-text array.', 400);
  }
  let totalBytes = 0;
  const output = pages.map((page, index) => {
    if (!page || typeof page !== 'object' || Array.isArray(page)
      || !Number.isSafeInteger(page.page) || page.page !== index + 1 || page.page < 1
      || typeof page.text !== 'string') {
      fail('INVALID_OOXML_TEXT_PAGES', 'Extracted page text must contain sequential page numbers and strings.', 400);
    }
    const text = page.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const lines = text.split('\n');
    if (lines.length > limits.maximumLinesPerPage) fail('OOXML_EXPORT_LIMIT_EXCEEDED', 'A page contains too many text lines.', 413);
    for (const line of lines) {
      if (line.length > limits.maximumLineCharacters) fail('OOXML_EXPORT_LIMIT_EXCEEDED', 'A text line exceeds the OOXML export limit.', 413);
      xmlEscape(line);
    }
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > limits.maximumTextBytes) fail('OOXML_EXPORT_LIMIT_EXCEEDED', 'Extracted text exceeds the OOXML export limit.', 413);
    return Object.freeze({ page: page.page, text, lines: Object.freeze(lines) });
  });
  return Object.freeze(output);
}

function docxEntries(pages) {
  const body = [];
  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    for (const line of page.lines) body.push(`<w:p><w:r>${textNode(line)}</w:r></w:p>`);
  });
  if (body.length === 0) body.push('<w:p/>');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}`
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
  return [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', document],
  ];
}

function cell(row, column, value) {
  const ref = `${column}${row}`;
  return `<c r="${ref}" t="inlineStr"><is><t${/^\s|\s$/u.test(value) ? ' xml:space="preserve"' : ''}>${xmlEscape(value)}</t></is></c>`;
}

function xlsxEntries(pages) {
  const rows = ['<row r="1">', cell(1, 'A', 'Page'), cell(1, 'B', 'Line'), cell(1, 'C', 'Text'), '</row>'];
  let row = 2;
  for (const page of pages) for (let lineIndex = 0; lineIndex < page.lines.length; lineIndex += 1) {
    rows.push(`<row r="${row}">`, cell(row, 'A', String(page.page)), cell(row, 'B', String(lineIndex + 1)), cell(row, 'C', page.lines[lineIndex]), '</row>');
    row += 1;
  }
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  return [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Pages" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ];
}

function pptTextParagraph(line) {
  return `<a:p><a:r><a:rPr lang="en-US"/><a:t>${xmlEscape(line)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>`;
}

function pptSlide(page) {
  const paragraphs = page.lines.map(pptTextParagraph).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Page text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="8229600" cy="5486400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function pptLayout() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
}

function pptMaster() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Master"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
}

function pptxEntries(pages) {
  const slides = pages.map((page, index) => [`ppt/slides/slide${index + 1}.xml`, pptSlide(page)]);
  const slideIds = pages.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('');
  const slideRels = pages.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('');
  const overrides = pages.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  return [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>${overrides}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>'],
    ['ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="1" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRels}</Relationships>`],
    ['ppt/slideMasters/slideMaster1.xml', pptMaster()],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>'],
    ['ppt/slideLayouts/slideLayout1.xml', pptLayout()],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>'],
    ...slides,
  ];
}

export function buildOoxml(format, pages, limits = OOXML_EXPORT_LIMITS) {
  const selected = FORMAT[format];
  if (!selected) fail('UNSUPPORTED_OOXML_FORMAT', 'OOXML export format must be word, excel, or powerpoint.', 400);
  const normalized = normalizePages(pages, limits);
  const entries = format === 'word' ? docxEntries(normalized) : format === 'excel' ? xlsxEntries(normalized) : pptxEntries(normalized);
  const bytes = writeStoredZip(entries);
  if (bytes.length > limits.maximumOutputBytes) fail('OOXML_EXPORT_LIMIT_EXCEEDED', 'OOXML output exceeds the bounded archive size.', 413);
  return Object.freeze({ format, extension: selected.extension, mediaType: selected.mediaType, bytes, pages: normalized });
}

function validatePackage(format, bytes, pages) {
  let entries;
  try { entries = readZipEntries(bytes); } catch (error) { fail('OOXML_OUTPUT_INVALID', 'The OOXML output failed ZIP round-trip validation.', 502, error); }
  const required = format === 'word'
    ? ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']
    : format === 'excel'
      ? ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']
      : ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slides/slide1.xml'];
  if (required.some((name) => !entries.has(name))) fail('OOXML_OUTPUT_INVALID', 'The OOXML output is missing a required package part.', 502);
  const allText = [...entries.values()].map((value) => value.toString('utf8')).join('\n');
  if (format === 'word' && pages.some((page) => page.lines.some((line) => !allText.includes(xmlEscape(line))))) fail('OOXML_OUTPUT_INVALID', 'The DOCX output does not contain every source text line.', 502);
  if (format === 'excel' && (entries.get('xl/worksheets/sheet1.xml').toString('utf8').match(/<row\b/g) ?? []).length !== pages.reduce((count, page) => count + page.lines.length, 1)) fail('OOXML_OUTPUT_INVALID', 'The XLSX worksheet row count did not match extracted page lines.', 502);
  if (format === 'powerpoint' && [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).length !== pages.length) fail('OOXML_OUTPUT_INVALID', 'The PPTX slide count did not match extracted pages.', 502);
  return entries;
}

export class PdfOoxmlExportService {
  #store; #extractor; #limits; #provenanceFactory;
  constructor({ store, extractor = null, limits = OOXML_EXPORT_LIMITS, provenanceFactory = null } = {}) {
    if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function' || typeof store.promoteOoxmlArtifact !== 'function') {
      throw new TypeError('PdfOoxmlExportService requires a source-bound store with OOXML artifact promotion.');
    }
    if (!extractor || typeof extractor.extractText !== 'function') throw new TypeError('PdfOoxmlExportService requires a source-bound text extractor.');
    if (provenanceFactory !== null && typeof provenanceFactory !== 'function') throw new TypeError('provenanceFactory must be a function when provided.');
    this.#store = store; this.#extractor = extractor; this.#limits = limits; this.#provenanceFactory = provenanceFactory;
  }

  async export(documentId, format, options = {}) {
    let optionValues;
    try { optionValues = exactDataRecord(options, ['sourceSha256', 'signal'], 'OOXML export options', ['sourceSha256']); }
    catch (error) { if (error instanceof HostError) throw new TypeError('OOXML export options are invalid.', { cause: error }); throw error; }
    const { sourceSha256, signal } = optionValues;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const selected = FORMAT[format];
    if (!selected) fail('UNSUPPORTED_OOXML_FORMAT', 'OOXML export format must be word, excel, or powerpoint.', 400);
    abort(signal);
    const source = this.#store.getDocument(documentId);
    if (!source || sourceSha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The OOXML export source digest does not match the current document.', 409);
    await this.#store.verifySource(documentId);
    abort(signal);
    let pageCount = source.pageCount;
    if (pageCount === undefined) {
      if (typeof this.#extractor.inspect !== 'function') fail('OOXML_TEXT_REQUIRED', 'A bounded source page count is required for text extraction.', 422);
      const inspectOptions = Object.freeze({ signal });
      const inspected = await this.#extractor.inspect(documentId, inspectOptions);
      pageCount = exactDataRecord(inspected, ['pageCount'], 'Extractor inspection').pageCount;
    }
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) fail('OOXML_TEXT_REQUIRED', 'A bounded source page count is required for text extraction.', 422);
    if (pageCount > this.#limits.maximumPages) fail('OOXML_EXPORT_LIMIT_EXCEEDED', 'The source contains too many pages for OOXML export.', 413);
    const extracted = await this.#extractor.extractText(documentId, pageCount, Object.freeze({ signal }));
    const envelope = exactDataRecord(extracted, ['sourceDigest', 'pageCount', 'pages'], 'Extractor text envelope');
    if (envelope.sourceDigest !== source.sha256 || envelope.pageCount !== pageCount || !Array.isArray(envelope.pages) || envelope.pages.length !== pageCount) {
      fail('OOXML_TEXT_UNBOUND', 'The text extractor did not return an exact source-bound page-text envelope.', 502);
    }
    const pagesSnapshot = snapshotPages(envelope.pages);
    await this.#store.verifySource(documentId);
    abort(signal);
    const built = buildOoxml(format, pagesSnapshot, this.#limits);
    try {
      abort(signal);
      validatePackage(format, built.bytes, built.pages);
      const workspace = await this.#store.createJobWorkspace(documentId);
      let promoted = null;
      let completed = false;
      try {
        const outputPath = join(workspace, `output.${selected.extension}`);
        await writeFile(outputPath, built.bytes, { mode: 0o600, flag: 'wx' });
        const outputSha256 = createHash('sha256').update(built.bytes).digest('hex');
        const operation = this.#provenanceFactory?.({ documentId, source, format, pages: built.pages, outputSha256 }) ?? createOperationProvenance({
          type: `export-${format}`,
          inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
          parameters: { profile: `local-pdf-${format}-text-only-v1`, pageCount: built.pages.length },
          expected: { pageCount: built.pages.length, textOnly: true, sourceUnchanged: true },
          validation: { passed: true, validators: ['source-sha256', 'source-text-bound', 'stored-zip-round-trip', 'ooxml-semantic-entries', 'artifact-sha256'], pageCount: built.pages.length, outputSha256 },
        });
        abort(signal);
        const promotedCandidate = await this.#store.promoteOoxmlArtifact(documentId, outputPath, {
          displayName: `${basename(source.displayName ?? 'document.pdf', extname(source.displayName ?? 'document.pdf'))}.${selected.extension}`,
          mediaType: selected.mediaType, extension: selected.extension, operation, expectedSha256: outputSha256, signal,
        });
        validatePromotedArtifact(promotedCandidate, selected, documentId, outputSha256, built.bytes.length);
        promoted = promotedCandidate;
        await this.#store.verifySource(documentId);
        abort(signal);
        completed = true;
        return Object.freeze({ kind: 'pdf-ooxml-export', format, extension: selected.extension, mediaType: selected.mediaType, sourceDigest: source.sha256, pageCount: built.pages.length, artifact: promoted, limitations: Object.freeze(['Text-only OOXML; no images, tables, exact layout, fonts, formulas, animations, speaker notes, or fidelity claims.']), localOnly: true });
      } finally {
        let cleanupError = null;
        try { await this.#store.cleanupJob(workspace); } catch (error) { cleanupError = error; }
        let revocationError = null;
        if (promoted && (!completed || cleanupError) && typeof this.#store.deleteArtifact === 'function') {
          try { await this.#store.deleteArtifact(promoted.id); } catch (error) { revocationError = error; }
        }
        if (cleanupError && revocationError) throw new OoxmlCleanupError([cleanupError, revocationError], 'OOXML export cleanup and artifact revocation both failed.');
        if (cleanupError) throw new OoxmlCleanupError([cleanupError]);
        if (revocationError) throw new OoxmlCleanupError([revocationError]);
      }
    } finally {
      built.bytes.fill(0);
    }
  }

  exportWord(documentId, options = {}) { return this.export(documentId, 'word', options); }
  exportExcel(documentId, options = {}) { return this.export(documentId, 'excel', options); }
  exportPowerpoint(documentId, options = {}) { return this.export(documentId, 'powerpoint', options); }
}

export { FORMAT as OOXML_EXPORT_FORMATS, normalizePages, validatePackage };
