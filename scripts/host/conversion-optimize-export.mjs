import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { validateOperationProvenance } from './operation-provenance.mjs';
import { parsePageDimensions, parsePdfInfo, parseTextPages } from './pdf-service-foundation.mjs';
import { readRegularOutput } from './bounded-output-io.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { runConversionJob } from './conversion-job-runtime.mjs';

export const MAX_OPTIMIZE_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_OPTIMIZE_EXPORT_PAGES = 200;
export const MAX_OPTIMIZE_EXPORT_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_OPTIMIZE_EXPORT_PAGE_POINTS = 14_400;

const OPTIMIZE_VALIDATORS = Object.freeze([
  'source-sha256', 'ghostscript-exit-zero', 'pdfinfo-page-count',
]);
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(code, message, status = 502, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function runOptions(workspace, signal, bytes, timeoutMs, maxStdoutBytes) {
  return {
    cwd: workspace, signal, stdin: bytes,
    maxStdinBytes: MAX_OPTIMIZE_EXPORT_BYTES,
    timeoutMs, maxStdoutBytes, maxStderrBytes: 128 * 1024,
  };
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new HostError('JOB_CANCELLED', 'Optimization export was cancelled.', 499);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function textDigest(pages) {
  const text = pages.map((page) => page.text).join('\n');
  return Object.freeze({ sha256: digest(Buffer.from(text, 'utf8')), bytes: Buffer.byteLength(text, 'utf8') });
}

function assertOptimizeProvenance(document, documents) {
  let operation;
  try { operation = validateOperationProvenance(document?.operation); } catch (error) {
    fail('INVALID_OPTIMIZE_PROVENANCE', 'Only a retained optimize-pdf derived document can be exported.', 403, error);
  }
  const input = operation.inputs.length === 1 ? operation.inputs[0] : null;
  const parameters = operation.parameters;
  const validators = operation.validation?.validators;
  const validParameters = parameters && Object.keys(parameters).length === 1 && parameters.mode === 'optimize';
  const valid = document?.origin === 'derived'
    && document.mediaType === 'application/pdf'
    && SHA256.test(document.sha256 ?? '')
    && Number.isSafeInteger(document.size)
    && document.size >= 64 && document.size <= MAX_OPTIMIZE_EXPORT_BYTES
    && operation.type === 'optimize-pdf'
    && input?.documentId
    && input.role === 'primary'
    && validParameters
    && Array.isArray(validators)
    && validators.length === OPTIMIZE_VALIDATORS.length
    && validators.every((value, index) => value === OPTIMIZE_VALIDATORS[index])
    && operation.validation.passed === true
    && Number.isSafeInteger(operation.validation.pageCount)
    && operation.validation.pageCount >= 1
    && operation.validation.pageCount <= MAX_OPTIMIZE_EXPORT_PAGES;
  if (!valid) fail('INVALID_OPTIMIZE_PROVENANCE', 'The retained document is not an optimize-pdf output with the fixed validator contract.', 403);
  const source = documents.getDocument(input.documentId);
  if (!source || input.sha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The optimize source no longer matches its recorded digest.', 409);
  return Object.freeze({ operation, source, input });
}

async function stageAndRead(documents, document, targetPath, signal, label) {
  const identity = await stagePrivateSourceCopy({
    sourcePath: documents.getSourcePath(document.id), targetPath,
    expectedSha256: document.sha256, expectedSize: document.size,
    maximumBytes: MAX_OPTIMIZE_EXPORT_BYTES, signal,
  });
  const bytes = await readRegularOutput(targetPath, {
    minimumBytes: 64, maximumBytes: MAX_OPTIMIZE_EXPORT_BYTES, label,
  });
  if (bytes.length !== document.size || digest(bytes) !== document.sha256) {
    fail('SOURCE_INTEGRITY_FAILED', `${label} bytes do not match the retained document record.`);
  }
  await assertPrivateSourceCopy({
    path: targetPath, identity, expectedSha256: document.sha256,
    expectedSize: document.size, maximumBytes: MAX_OPTIMIZE_EXPORT_BYTES,
  });
  return Object.freeze({ bytes, identity });
}

async function inspectBytes(poppler, workspace, bytes, signal, label) {
  const inspection = parsePdfInfo((await poppler.execute(
    'inspectStdin', {}, runOptions(workspace, signal, bytes, 20_000, 512 * 1024),
  )).stdout);
  if (inspection.pageCount < 1 || inspection.pageCount > MAX_OPTIMIZE_EXPORT_PAGES) {
    fail('OPTIMIZE_EXPORT_LIMIT', `${label} has an unsupported page count.`, 422);
  }
  const pages = [];
  for (let page = 1; page <= inspection.pageCount; page += 1) {
    pages.push(parsePageDimensions((await poppler.execute(
      'inspectPageStdin', { page }, runOptions(workspace, signal, bytes, 20_000, 512 * 1024),
    )).stdout, page));
  }
  const textPages = parseTextPages((await poppler.execute(
    'extractTextStdin', { layout: true },
    runOptions(workspace, signal, bytes, 30_000, MAX_OPTIMIZE_EXPORT_TEXT_BYTES),
  )).stdout, inspection.pageCount);
  const textBytes = textPages.reduce((sum, page) => sum + Buffer.byteLength(page.text, 'utf8'), 0);
  if (textPages.length !== inspection.pageCount || textBytes > MAX_OPTIMIZE_EXPORT_TEXT_BYTES
    || pages.some((page) => page.widthPoints > MAX_OPTIMIZE_EXPORT_PAGE_POINTS || page.heightPoints > MAX_OPTIMIZE_EXPORT_PAGE_POINTS)) {
    fail('OPTIMIZE_EXPORT_LIMIT', `${label} exceeded the bounded geometry or text limits.`, 422);
  }
  return Object.freeze({ inspection, pages: Object.freeze(pages), textPages: Object.freeze(textPages) });
}

function samePages(source, output) {
  return source.pageCount === output.pageCount
    && source.pages.length === output.pages.length
    && source.pages.every((page, index) => page.page === output.pages[index].page
      && page.widthPoints === output.pages[index].widthPoints
      && page.heightPoints === output.pages[index].heightPoints)
    && source.textPages.length === output.textPages.length
    && source.textPages.every((page, index) => page.page === output.textPages[index].page
      && page.text === output.textPages[index].text);
}

export async function prepareOptimizePdfExport({ documents, poppler, documentId, externalSignal }) {
  if (!documents || !poppler || typeof documents.getDocument !== 'function') throw new TypeError('Optimization export requires documents and Poppler authorities.');
  const document = documents.getDocument(documentId);
  const { source } = assertOptimizeProvenance(document, documents);
  return runConversionJob({
    owner: documents, resourceId: documentId, externalSignal,
    action: async ({ workspace, signal, checkQuota, registerPromotedDocument }) => {
      registerPromotedDocument(document);
      await documents.verifySource(source.id);
      await documents.verifySource(document.id);
      const sourceStaged = await stageAndRead(documents, source, join(workspace, 'immutable-optimize-source.pdf'), signal, 'Optimize source snapshot');
      const outputStaged = await stageAndRead(documents, document, join(workspace, 'immutable-optimize-output.pdf'), signal, 'Optimize output snapshot');
      await checkQuota();
      const sourceEvidence = await inspectBytes(poppler, workspace, sourceStaged.bytes, signal, 'Optimize source');
      const outputEvidence = await inspectBytes(poppler, workspace, outputStaged.bytes, signal, 'Optimize output');
      if (String(outputEvidence.inspection.encrypted).toLowerCase() !== 'no'
        || String(outputEvidence.inspection.javascript).toLowerCase() !== 'no'
        || String(outputEvidence.inspection.form).toLowerCase() !== 'none') {
        fail('OPTIMIZE_OUTPUT_NOT_PASSIVE', 'The optimized PDF is not passive, unencrypted, and form-free.', 502);
      }
      if (!samePages(sourceEvidence, outputEvidence)) {
        fail('OPTIMIZE_SEMANTIC_MISMATCH', 'The optimized PDF changed page count, geometry, or extracted text.', 502);
      }
      await documents.verifySource(source.id);
      await documents.verifySource(document.id);
      assertNotAborted(signal);
      const sourceText = textDigest(sourceEvidence.textPages);
      const outputText = textDigest(outputEvidence.textPages);
      return Object.freeze({
        bytes: outputStaged.bytes,
        sourceBytes: sourceStaged.bytes,
        sourceDigest: source.sha256,
        outputDigest: document.sha256,
        sourceSize: source.size,
        outputSize: document.size,
        savedBytes: Math.max(0, source.size - document.size),
        reduced: document.size < source.size,
        pageCount: outputEvidence.inspection.pageCount,
        sourcePageGeometry: sourceEvidence.pages,
        pageGeometry: outputEvidence.pages,
        sourceTextPages: sourceEvidence.textPages,
        textPages: outputEvidence.textPages,
        sourceTextDigest: sourceText.sha256,
        outputTextDigest: outputText.sha256,
        textBytes: outputText.bytes,
        geometryPreserved: true,
        textPreserved: true,
        passiveIndicators: Object.freeze({ encrypted: 'no', javascript: 'no', form: 'none' }),
        derivedDocument: document,
      });
    },
  });
}

export const prepareOptimizeCompressExport = prepareOptimizePdfExport;
export { OPTIMIZE_VALIDATORS, assertOptimizeProvenance };
