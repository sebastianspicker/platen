import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readRegularOutput } from './bounded-output-io.mjs';
import { runConversionJob } from './conversion-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import {
  parsePageDimensions,
  parsePdfInfo,
  parseTextPages,
} from './pdf-service-foundation.mjs';
import {
  assertPrivateSourceCopy,
  stagePrivateSourceCopy,
} from './private-source-copy.mjs';

export const MAX_POSTSCRIPT_PDF_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_POSTSCRIPT_PDF_EXPORT_PAGES = 64;
const MAX_POSTSCRIPT_PDF_TEXT_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

function invalidPostScriptDocument(message, status = 422) {
  throw new HostError('INVALID_POSTSCRIPT_PDF_DOCUMENT', message, status);
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('PostScript-to-PDF export validation was cancelled.');
  error.code = 'ENGINE_CANCELLED';
  throw error;
}

function runOptions(workspace, signal, timeoutMs, maxStdoutBytes, bytes) {
  return {
    cwd: workspace,
    signal,
    stdin: bytes,
    maxStdinBytes: MAX_POSTSCRIPT_PDF_EXPORT_BYTES,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes: 128 * 1024,
  };
}

function assertExactProvenance(source) {
  const operation = source.operation;
  const parameters = operation?.parameters;
  const validators = operation?.validation?.validators;
  if (source.origin !== 'derived'
    || source.mediaType !== 'application/pdf'
    || operation?.type !== 'postscript-to-pdf'
    || !parameters || Object.keys(parameters).length !== 2
    || !['ps', 'eps'].includes(parameters.sourceFormat)
    || parameters.sourceKind !== 'postscript'
    || !Array.isArray(validators)
    || validators.length !== 3
    || validators[0] !== 'source-sha256'
    || validators[1] !== 'ghostscript-exit-zero'
    || validators[2] !== 'pdfinfo-page-count'
    || operation.validation.passed !== true
    || operation.inputs?.length !== 1
    || typeof operation.inputs[0]?.assetId !== 'string'
    || !SHA256.test(operation.inputs[0]?.sha256 ?? '')
    || !Number.isSafeInteger(operation.validation?.pageCount)
    || operation.validation.pageCount < 1
    || operation.validation.pageCount > MAX_POSTSCRIPT_PDF_EXPORT_PAGES
    || !Number.isSafeInteger(source.size)
    || source.size < 5
    || source.size > MAX_POSTSCRIPT_PDF_EXPORT_BYTES
    || !SHA256.test(source.sha256 ?? '')) {
    invalidPostScriptDocument('Only a Ghostscript-produced PostScript-derived PDF can be exported.', 403);
  }
}

async function stageSource(documents, documentId, source, input, signal) {
  try {
    return await stagePrivateSourceCopy({
      sourcePath: documents.getSourcePath(documentId),
      targetPath: input,
      expectedSha256: source.sha256,
      expectedSize: source.size,
      maximumBytes: MAX_POSTSCRIPT_PDF_EXPORT_BYTES,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'PostScript-to-PDF export could not bind the derived PDF to a private snapshot.',
      500,
      { cause: error },
    );
  }
}

async function assertStaged(input, identity, source) {
  try {
    await assertPrivateSourceCopy({
      path: input,
      identity,
      expectedSha256: source.sha256,
      expectedSize: source.size,
      maximumBytes: MAX_POSTSCRIPT_PDF_EXPORT_BYTES,
    });
  } catch (error) {
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'PostScript-to-PDF export snapshot changed during validation.',
      500,
      { cause: error },
    );
  }
}

function assertPassivePdf(inspection) {
  if (inspection.encrypted !== 'no'
    || inspection.javascript !== 'no'
    || inspection.form !== 'none') {
    invalidPostScriptDocument('PostScript-to-PDF export requires a passive, unencrypted PDF without JavaScript or forms.');
  }
}

function assertTextCoverage(textPages, pageCount) {
  if (textPages.length !== pageCount
    || textPages.some((page, index) => page.page !== index + 1)) {
    invalidPostScriptDocument('PostScript-to-PDF text extraction did not cover pages sequentially.');
  }
  const textBytes = textPages.reduce(
    (total, page) => total + Buffer.byteLength(page.text, 'utf8'),
    0,
  );
  if (textBytes > MAX_POSTSCRIPT_PDF_TEXT_BYTES) {
    throw new HostError(
      'POSTSCRIPT_PDF_TEXT_LIMIT',
      'PostScript-to-PDF text evidence exceeds the bounded export limit.',
      422,
    );
  }
}

export async function preparePostScriptPdfDocumentExport({
  documents,
  poppler,
  documentId,
  externalSignal,
}) {
  const source = documents.getDocument(documentId);
  if (source.size < 5 || source.size > MAX_POSTSCRIPT_PDF_EXPORT_BYTES) {
    invalidPostScriptDocument('The derived PostScript PDF is outside the bounded export size.', 502);
  }
  assertExactProvenance(source);
  return runConversionJob({
    owner: documents,
    resourceId: documentId,
    externalSignal,
    action: async ({ workspace, signal, checkQuota }) => {
      const input = join(workspace, 'immutable-postscript-pdf-source.pdf');
      await documents.verifySource(documentId);
      const identity = await stageSource(documents, documentId, source, input, signal);
      await checkQuota();
      const bytes = await readRegularOutput(input, {
        minimumBytes: 5,
        maximumBytes: MAX_POSTSCRIPT_PDF_EXPORT_BYTES,
        label: 'Derived PostScript PDF snapshot',
      });
      if (bytes.length !== source.size
        || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        throw new HostError(
          'SOURCE_INTEGRITY_FAILED',
          'PostScript-to-PDF export bytes do not match the derived document record.',
          500,
        );
      }
      await assertStaged(input, identity, source);
      const inspection = parsePdfInfo((await poppler.execute(
        'inspectStdin', {}, runOptions(workspace, signal, 20_000, 512 * 1024, bytes),
      )).stdout);
      if (inspection.pageCount > MAX_POSTSCRIPT_PDF_EXPORT_PAGES) {
        throw new HostError(
          'POSTSCRIPT_PDF_PAGE_LIMIT',
          `PostScript-to-PDF export is limited to ${MAX_POSTSCRIPT_PDF_EXPORT_PAGES} pages.`,
          422,
        );
      }
      assertPassivePdf(inspection);
      const pages = [];
      for (let page = 1; page <= inspection.pageCount; page += 1) {
        pages.push(parsePageDimensions((await poppler.execute(
          'inspectPageStdin', { page },
          runOptions(workspace, signal, 20_000, 512 * 1024, bytes),
        )).stdout, page));
      }
      const textPages = parseTextPages((await poppler.execute(
        'extractTextStdin', { layout: true },
        runOptions(workspace, signal, 30_000, MAX_POSTSCRIPT_PDF_TEXT_BYTES, bytes),
      )).stdout, inspection.pageCount);
      assertTextCoverage(textPages, inspection.pageCount);
      assertNotAborted(signal);
      await checkQuota();
      await assertStaged(input, identity, source);
      await documents.verifySource(documentId);
      assertNotAborted(signal);
      return Object.freeze({
        bytes,
        inspection,
        pages: Object.freeze(pages),
        textPages,
      });
    },
  });
}
