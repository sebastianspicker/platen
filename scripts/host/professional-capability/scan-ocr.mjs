import {
  scanAcquire as scannerAcquire,
  scanDuplexFeeder as scannerDuplexFeeder,
  scanAppendToDocument as scannerAppendToDocument,
} from './scan-ocr-scanner.mjs';
import {
  ocrRecognizeText,
  ocrCleanup,
  ocrEditableOutput,
  ocrSuspectReview,
  ocrLanguageDetectionSelection,
  ocrZonesLayout,
  ocrTableRecognition,
  ocrUserDictionariesTraining,
  ocrBatchRecognition,
  ocrExportLayoutPreserving,
  ocrScreenshotCapture,
} from './scan-ocr-ocr.mjs';
import { readFileSync } from 'node:fs';
import { OPAQUE_ID } from '../document-store-contract.mjs';
import { validateOperationProvenance } from '../operation-provenance.mjs';
import { SCANNER_DUPLEX_MAX_PAGES } from '../scanner-duplex-contract.mjs';
import { PDF_COPY_PAGE_VALIDATORS, PDF_COPY_PAGE_PROFILE } from '../pdf-copy-page-contract.mjs';
import { fail, sha256 } from './support.mjs';

const DIGEST = /^[0-9a-f]{64}$/u;

function duplexInput(ctx) {
  if (ctx.sides !== undefined && ctx.sides !== 'duplex') {
    fail('INVALID_DUPLEX_SIDES', 'scan.duplex-feeder accepts duplex sides only.', 400);
  }
  const sheets = ctx.sheets === undefined ? 1 : ctx.sheets;
  if (!Number.isSafeInteger(sheets) || sheets < 1 || sheets > SCANNER_DUPLEX_MAX_PAGES / 2) {
    fail('INVALID_SHEETS', `sheets 1..${SCANNER_DUPLEX_MAX_PAGES / 2}`, 400);
  }
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Scanner acquisition is local-only.', 403);
  return Object.freeze({ sheets, pageCount: sheets * 2 });
}

function documentRecord(store, id, role) {
  if (!OPAQUE_ID.test(String(id ?? ''))) {
    fail('SCAN_APPEND_CONTEXT_INVALID', `${role} source document identifier is invalid.`, 400);
  }
  let record;
  try { record = store.getDocument(id); }
  catch (error) {
    if (error?.code === 'DOCUMENT_NOT_FOUND') {
      fail('SCAN_APPEND_CONTEXT_INVALID', `${role} source document was not found in the local store.`, 400);
    }
    fail('SCAN_APPEND_OUTPUT_INVALID', `Could not read ${role.toLowerCase()} source document binding.`, 502);
  }
  if (!record || record.id !== id || record.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(record.size) || record.size < 1 || !DIGEST.test(record.sha256 ?? '')) {
    fail('SCAN_APPEND_CONTEXT_INVALID', `${role} source document binding is malformed.`, 400);
  }
  return record;
}

async function verifyAppendSources(ctx) {
  if (!ctx.store || typeof ctx.store.getDocument !== 'function'
    || typeof ctx.store.verifySource !== 'function' || typeof ctx.store.getSourcePath !== 'function') {
    fail('SCAN_APPEND_SERVICE_UNAVAILABLE', 'scan.append-to-document requires a source-bound document store.', 503);
  }
  const primaryId = typeof ctx.documentId === 'string' ? ctx.documentId : '';
  const secondaryId = typeof ctx.scanDocumentId === 'string' ? ctx.scanDocumentId : '';
  const primary = documentRecord(ctx.store, primaryId, 'Primary');
  const secondary = documentRecord(ctx.store, secondaryId, 'Scanned');
  try {
    await ctx.store.verifySource(primary.id);
    await ctx.store.verifySource(secondary.id);
    ctx.store.getSourcePath(primary.id);
    ctx.store.getSourcePath(secondary.id);
  } catch (error) {
    if (error?.code === 'SOURCE_INTEGRITY_FAILED') {
      fail('SCAN_APPEND_OUTPUT_INVALID', 'A source document drifted before append composition.', 502);
    }
    fail('SCAN_APPEND_CONTEXT_INVALID', 'The append source documents could not be verified.', 400);
  }
  return { primary, secondary };
}

function exactAppendProvenance(operation, { primary, secondary }, afterPage) {
  let checked;
  try { checked = validateOperationProvenance(operation); }
  catch { fail('SCAN_APPEND_OPERATION_INVALID', 'scan.append-to-document operation provenance is malformed.', 502); }
  if (checked.type !== 'copy-page-between-documents'
    || JSON.stringify(checked.inputs) !== JSON.stringify([
      { documentId: primary.id, sha256: primary.sha256, role: 'primary' },
      { documentId: secondary.id, sha256: secondary.sha256, role: 'secondary' },
    ])) {
    fail('SCAN_APPEND_OPERATION_INVALID', 'scan.append-to-document source provenance is invalid.', 502);
  }
  const parameters = checked.parameters;
  if (parameters?.profile !== PDF_COPY_PAGE_PROFILE || parameters.sourcePage !== 1
    || parameters.afterPage !== afterPage || !Array.isArray(parameters.selections)) {
    fail('SCAN_APPEND_OPERATION_INVALID', 'scan.append-to-document selection provenance is invalid.', 502);
  }
  const expectedSelections = [
    ...Array.from({ length: afterPage }, (_, index) => ({ input: 0, page: index + 1 })),
    { input: 1, page: 1 },
    ...Array.from({ length: Math.max(0, checked.expected.pageCount - afterPage - 1) }, (_, index) => ({ input: 0, page: afterPage + index + 1 })),
  ];
  if (JSON.stringify(parameters.selections) !== JSON.stringify(expectedSelections)
    || !Number.isSafeInteger(checked.expected.pageCount)
    || checked.expected.pageCount !== expectedSelections.length) {
    fail('SCAN_APPEND_OPERATION_INVALID', 'scan.append-to-document selection order is invalid.', 502);
  }
  if (!DIGEST.test(checked.expected.manifestSha256 ?? '')
    || checked.expected.manifestSha256 !== checked.validation.manifestSha256
    || JSON.stringify(checked.validation.validators) !== JSON.stringify(PDF_COPY_PAGE_VALIDATORS)) {
    fail('SCAN_APPEND_OPERATION_INVALID', 'scan.append-to-document semantic manifest validation is invalid.', 502);
  }
  return checked;
}

async function scanDuplexFeeder(ctx = {}) {
  duplexInput(ctx);
  if (ctx.service === undefined || ctx.store === undefined) {
    // Preserve the service-owned availability error, but only after input validation.
    return scannerDuplexFeeder(ctx);
  }
  const result = await scannerDuplexFeeder(ctx);
  if (result.receipt?.sha256 && result.outputSha256 !== result.receipt.sha256) {
    fail('SCAN_DUPLEX_OUTPUT_INVALID', 'scan.duplex-feeder output digest drifted from its document receipt.', 502);
  }
  return result;
}

async function scanAppendToDocument(ctx = {}) {
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Scanner acquisition is local-only.', 403);
  const sources = await verifyAppendSources(ctx);
  const afterPage = ctx.afterPage === undefined ? 0 : ctx.afterPage;
  if (!Number.isSafeInteger(afterPage) || afterPage < 0) {
    fail('SCAN_APPEND_REQUEST_INVALID', 'afterPage must be non-negative.', 400);
  }
  const result = await scannerAppendToDocument(ctx);
  const operation = exactAppendProvenance(result.operation, sources, afterPage);
  let artifact;
  try {
    artifact = ctx.store.getArtifact(result.artifactId);
    await ctx.store.verifySource(sources.primary.id);
    await ctx.store.verifySource(sources.secondary.id);
  } catch (error) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'scan.append-to-document artifact or source could not be reread.', 502);
  }
  let bytes;
  try { bytes = readFileSync(artifact.filePath); }
  catch { fail('SCAN_APPEND_OUTPUT_INVALID', 'scan.append-to-document artifact bytes could not be reread.', 502); }
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== artifact.sha256 || artifact.sha256 !== result.outputSha256
    || artifact.size !== bytes.length) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'scan.append-to-document artifact digest binding is invalid.', 502);
  }
  return Object.freeze({ ...result, operation, pdf: bytes, bytes, outputSha256: artifact.sha256, outputDigest: artifact.sha256 });
}

const scanAcquire = scannerAcquire;

export {
  scanAcquire,
  scanDuplexFeeder,
  scanAppendToDocument,
  ocrRecognizeText,
  ocrCleanup,
  ocrEditableOutput,
  ocrSuspectReview,
  ocrLanguageDetectionSelection,
  ocrZonesLayout,
  ocrTableRecognition,
  ocrUserDictionariesTraining,
  ocrBatchRecognition,
  ocrExportLayoutPreserving,
  ocrScreenshotCapture,
};

export const handlers = Object.freeze({
  async 'scan.acquire'(ctx = {}) { return scanAcquire(ctx); },
  async 'scan.duplex-feeder'(ctx = {}) { return scanDuplexFeeder(ctx); },
  async 'scan.append-to-document'(ctx = {}) { return scanAppendToDocument(ctx); },
  async 'ocr.recognize-text'(ctx = {}) { return ocrRecognizeText(ctx); },
  async 'ocr.cleanup'(ctx = {}) { return ocrCleanup(ctx); },
  async 'ocr.editable-output'(ctx = {}) { return ocrEditableOutput(ctx); },
  async 'ocr.suspect-review'(ctx = {}) { return ocrSuspectReview(ctx); },
  async 'ocr.language-detection-selection'(ctx = {}) { return ocrLanguageDetectionSelection(ctx); },
  async 'ocr.zones-layout'(ctx = {}) { return ocrZonesLayout(ctx); },
  async 'ocr.table-recognition'(ctx = {}) { return ocrTableRecognition(ctx); },
  async 'ocr.user-dictionaries-training'(ctx = {}) { return ocrUserDictionariesTraining(ctx); },
  async 'ocr.batch-recognition'(ctx = {}) { return ocrBatchRecognition(ctx); },
  async 'ocr.export-layout-preserving'(ctx = {}) { return ocrExportLayoutPreserving(ctx); },
  async 'ocr.screenshot-capture'(ctx = {}) { return ocrScreenshotCapture(ctx); },
});
