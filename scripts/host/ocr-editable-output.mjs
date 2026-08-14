import { createHash } from 'node:crypto';
import { createOperationProvenance } from './operation-provenance.mjs';
import { HostError } from './host-error.mjs';
import { OOXML_EXPORT_LIMITS, PdfOoxmlExportService } from './pdf-ooxml-export.mjs';
import { types as utilTypes } from 'node:util';

export const OCR_EDITABLE_OUTPUT_PROFILE = 'local-ocr-editable-docx-v1';
export const OCR_EDITABLE_OUTPUT_LANGUAGE = 'eng';
export const OCR_EDITABLE_OUTPUT_LIMITS = Object.freeze({
  maximumPages: 10,
  maximumLinesPerPage: OOXML_EXPORT_LIMITS.maximumLinesPerPage,
  maximumLineCharacters: OOXML_EXPORT_LIMITS.maximumLineCharacters,
  maximumTextBytes: OOXML_EXPORT_LIMITS.maximumTextBytes,
  maximumOutputBytes: OOXML_EXPORT_LIMITS.maximumOutputBytes,
});

function fail(code, message, status = 422, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value === 'function' || utilTypes.isProxy(value)) fail('OCR_EDITABLE_RECEIPT_INVALID', `${label} must be a data record.`, 502);
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch (error) { fail('OCR_EDITABLE_RECEIPT_INVALID', `${label} could not be inspected safely.`, 502, error); }
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) fail('OCR_EDITABLE_RECEIPT_INVALID', `${label} contains unexpected fields.`, 502);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('OCR_EDITABLE_RECEIPT_INVALID', `${label} contains an accessor field.`, 502);
    output[key] = descriptor.value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('OCR_EDITABLE_RECEIPT_INVALID', `${label} has an unexpected prototype.`, 502);
  return output;
}

function exactOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) throw new TypeError('OCR editable output options are invalid.');
  let keys;
  try { keys = Reflect.ownKeys(value); } catch (error) { throw new TypeError('OCR editable output options are invalid.', { cause: error }); }
  if (keys.some((key) => typeof key !== 'string' || !['sourceSha256', 'signal'].includes(key))) throw new TypeError('OCR editable output options are invalid.');
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('OCR editable output options are invalid.');
    output[key] = descriptor.value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('OCR editable output options are invalid.');
  return output;
}

function snapshotPages(value, pageCount) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length !== pageCount) fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR receipt page count is not exact.', 502);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR receipt pages must use the native array prototype.', 502);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== pageCount + 1 || !keys.includes('length') || [...Array(pageCount).keys()].some((index) => !keys.includes(String(index)))) fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR receipt pages contain unexpected fields.', 502);
  const pages = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR receipt pages contain an accessor element.', 502);
    const page = exactRecord(descriptor.value, ['page', 'text'], `OCR receipt page ${index + 1}`);
    if (page.page !== index + 1 || typeof page.text !== 'string') fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR receipt pages must be sequential text records.', 502);
    pages.push(Object.freeze({ page: page.page, text: page.text }));
  }
  return Object.freeze(pages);
}

function validateReceipt(receipt, sourceDigest, pageCount, limits) {
  const value = exactRecord(receipt, ['schema', 'version', 'sourceDigest', 'language', 'engine', 'pageCount', 'pages'], 'OCR receipt');
  if (value.schema !== 'ocr-editable-text-receipt-v1' || value.version !== 1 || value.sourceDigest !== sourceDigest
    || value.language !== OCR_EDITABLE_OUTPUT_LANGUAGE || value.pageCount !== pageCount
    || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > limits.maximumPages) {
    fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR receipt is not bound to the current bounded source.', 502);
  }
  const engine = exactRecord(value.engine, ['name', 'version'], 'OCR receipt engine');
  if (engine.name !== 'Tesseract' || typeof engine.version !== 'string' || !/^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/u.test(engine.version)) {
    fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR receipt engine identity is invalid.', 502);
  }
  const pages = snapshotPages(value.pages, pageCount);
  let textBytes = 0;
  for (const page of pages) {
    const lines = page.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
    if (lines.length > limits.maximumLinesPerPage || lines.some((line) => line.length > limits.maximumLineCharacters)) fail('OCR_EDITABLE_OUTPUT_LIMIT', 'OCR text exceeds the editable DOCX line limits.', 413);
    textBytes += Buffer.byteLength(page.text, 'utf8');
    if (textBytes > limits.maximumTextBytes) fail('OCR_EDITABLE_OUTPUT_LIMIT', 'OCR text exceeds the editable DOCX text limit.', 413);
  }
  const receiptDigest = createHash('sha256').update(JSON.stringify({ schema: value.schema, version: value.version, sourceDigest, language: value.language, engine: { name: engine.name, version: engine.version }, pageCount, pages })).digest('hex');
  return Object.freeze({ sourceDigest, pageCount, pages, engine: Object.freeze({ name: engine.name, version: engine.version }), language: value.language, receiptDigest });
}

export function receiptFromOcrLayout(layout, { engineVersion } = {}) {
  if (!layout || layout.kind !== 'ocr-layout-evidence' || layout.sourceDigest === undefined || layout.language !== OCR_EDITABLE_OUTPUT_LANGUAGE || !Array.isArray(layout.records)) fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR layout evidence cannot be converted into an editable receipt.', 502);
  if (typeof engineVersion !== 'string') fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR engine version is required for editable output provenance.', 502);
  const records = [...layout.records].sort((left, right) => left.page - right.page || String(left.zoneId ?? '').localeCompare(String(right.zoneId ?? '')));
  const grouped = new Map();
  for (const record of records) {
    if (!record || !Number.isSafeInteger(record.page) || record.page < 1) fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR layout pages are malformed.', 502);
    const words = record.layout?.words;
    const byLine = new Map();
    if (Array.isArray(words)) for (const word of words) {
      if (!word || !Number.isSafeInteger(word.line) || typeof word.text !== 'string') fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR layout words are malformed.', 502);
      const line = byLine.get(word.line) ?? []; line.push(word); byLine.set(word.line, line);
    }
    const text = [...byLine.entries()].sort(([left], [right]) => left - right)
      .map(([, line]) => line.sort((left, right) => (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0)).map(({ text }) => text).join(' ')).join('\n');
    const page = grouped.get(record.page) ?? []; page.push(text); grouped.set(record.page, page);
  }
  const pageNumbers = [...grouped.keys()].sort((left, right) => left - right);
  const pages = pageNumbers.map((page, index) => {
    if (page !== index + 1) fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR layout pages must be complete and sequential.', 502);
    return Object.freeze({ page, text: grouped.get(page).filter(Boolean).join('\n') });
  });
  if (!pages.some(({ text }) => text.length > 0)) fail('OCR_NO_TEXT', 'Tesseract did not recognize text for editable output.', 422);
  return Object.freeze({ schema: 'ocr-editable-text-receipt-v1', version: 1, sourceDigest: layout.sourceDigest, language: OCR_EDITABLE_OUTPUT_LANGUAGE, engine: Object.freeze({ name: 'Tesseract', version: engineVersion }), pageCount: pages.length, pages: Object.freeze(pages) });
}

export class OcrEditableOutputService {
  #store; #ocr; #limits;
  constructor({ store, ocr, limits = OCR_EDITABLE_OUTPUT_LIMITS } = {}) {
    if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function' || typeof store.promoteOoxmlArtifact !== 'function') throw new TypeError('OcrEditableOutputService requires a source-bound document store.');
    if (!ocr || typeof ocr.inspect !== 'function' || typeof ocr.extractReceipt !== 'function') throw new TypeError('OcrEditableOutputService requires a trusted OCR receipt extractor.');
    this.#store = store; this.#ocr = ocr; this.#limits = limits;
  }

  async export(documentId, options = {}) {
    const { sourceSha256, signal } = exactOptions(options);
    const source = this.#store.getDocument(documentId);
    if (!source || sourceSha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The OCR editable output source digest does not match the current document.', 409);
    let receipt = null;
    const service = new PdfOoxmlExportService({
      store: this.#store,
      limits: this.#limits,
      extractor: {
        inspect: (...args) => this.#ocr.inspect(...args),
        extractText: async (id, pageCount, extractOptions) => {
          receipt = validateReceipt(await this.#ocr.extractReceipt(id, pageCount, { ...extractOptions, language: OCR_EDITABLE_OUTPUT_LANGUAGE }), source.sha256, pageCount, this.#limits);
          return { sourceDigest: receipt.sourceDigest, pageCount: receipt.pageCount, pages: receipt.pages };
        },
      },
      provenanceFactory: ({ documentId: id, source: currentSource, pages, outputSha256 }) => {
        if (!receipt) fail('OCR_EDITABLE_RECEIPT_INVALID', 'OCR receipt was not captured before DOCX promotion.', 502);
        return createOperationProvenance({
          type: 'ocr-editable-output',
          inputs: [{ documentId: id, sha256: currentSource.sha256, role: 'source' }],
          parameters: { profile: OCR_EDITABLE_OUTPUT_PROFILE, language: receipt.language, engine: receipt.engine, pageCount: pages.length, receiptSha256: receipt.receiptDigest },
          expected: { pageCount: pages.length, textOnly: true, editable: true, sourceUnchanged: true },
          validation: { passed: true, validators: ['source-sha256', 'trusted-ocr-receipt', 'ocr-engine-version', 'stored-zip-round-trip', 'docx-text-round-trip', 'artifact-sha256'], pageCount: pages.length, outputSha256 },
        });
      },
    });
    const result = await service.export(documentId, 'word', { sourceSha256, signal });
    return Object.freeze({ kind: 'ocr-editable-output', schemaVersion: 1, format: 'word', extension: result.extension, mediaType: result.mediaType, sourceDigest: result.sourceDigest, pageCount: result.pageCount, language: receipt.language, engine: receipt.engine, artifact: result.artifact, evidence: Object.freeze({ localOnly: true, sourceBound: true, ocrReceipt: true, receiptSha256: receipt.receiptDigest, textOnly: true }), limitations: Object.freeze(['Text-only editable DOCX; OCR recognition requires review. No images, tables, exact layout, fonts, or fidelity claims.']) });
  }

  exportOcrEditable(documentId, options = {}) { return this.export(documentId, options); }
}
