import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readRegularOutput } from './bounded-output-io.mjs';
import { runConversionJob } from './conversion-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import {
  parseImages,
  parsePageDimensions,
  parsePdfInfo,
  parseTextPages,
} from './pdf-service-foundation.mjs';
import {
  assertPrivateSourceCopy,
  stagePrivateSourceCopy,
} from './private-source-copy.mjs';

export const MAX_PNG_PDF_EXPORT_BYTES = 64 * 1024 * 1024;

function assertNotAborted(signal) {
  if (!signal.aborted) return;
  const error = new Error('PNG-to-PDF export validation was cancelled.');
  error.code = 'ENGINE_CANCELLED';
  throw error;
}

function runOptions(workspace, signal, timeoutMs, maxStdoutBytes, bytes) {
  return {
    cwd: workspace,
    signal,
    stdin: bytes,
    maxStdinBytes: MAX_PNG_PDF_EXPORT_BYTES,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes: 128 * 1024,
  };
}

async function stageSource(documents, documentId, source, input, signal) {
  try {
    return await stagePrivateSourceCopy({
      sourcePath: documents.getSourcePath(documentId),
      targetPath: input,
      expectedSha256: source.sha256,
      expectedSize: source.size,
      maximumBytes: MAX_PNG_PDF_EXPORT_BYTES,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'PNG-to-PDF export could not bind the derived PDF to a private snapshot.',
      500,
      { cause: error },
    );
  }
}

async function assertStaged(input, identity, source, signal) {
  assertNotAborted(signal);
  try {
    await assertPrivateSourceCopy({
      path: input,
      identity,
      expectedSha256: source.sha256,
      expectedSize: source.size,
      maximumBytes: MAX_PNG_PDF_EXPORT_BYTES,
    });
  } catch (error) {
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'PNG-to-PDF export snapshot changed during validation.',
      500,
      { cause: error },
    );
  }
}

export async function preparePngPdfDocumentExport({
  documents,
  poppler,
  documentId,
  externalSignal,
}) {
  const source = documents.getDocument(documentId);
  if (source.size < 64 || source.size > MAX_PNG_PDF_EXPORT_BYTES) {
    throw new HostError(
      'INVALID_PNG_PDF_DOCUMENT',
      'The derived PNG PDF is outside the bounded export size.',
      502,
    );
  }
  return runConversionJob({
    owner: documents,
    resourceId: documentId,
    externalSignal,
    action: async ({ workspace, signal, checkQuota }) => {
      const input = join(workspace, 'immutable-png-document.pdf');
      await documents.verifySource(documentId);
      const identity = await stageSource(
        documents, documentId, source, input, signal,
      );
      await checkQuota();
      const bytes = await readRegularOutput(input, {
        minimumBytes: 64,
        maximumBytes: MAX_PNG_PDF_EXPORT_BYTES,
        label: 'Derived PNG PDF snapshot',
      });
      if (bytes.length !== source.size
        || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        throw new HostError(
          'SOURCE_INTEGRITY_FAILED',
          'PNG-to-PDF export bytes do not match the derived document record.',
          500,
        );
      }
      await assertStaged(input, identity, source, signal);

      const inspection = parsePdfInfo((await poppler.execute(
        'inspectStdin', {}, runOptions(workspace, signal, 20_000, 512 * 1024, bytes),
      )).stdout);
      if (inspection.pageCount !== 1) {
        throw new HostError(
          'INVALID_PNG_PDF_DOCUMENT',
          'PNG-to-PDF export requires exactly one derived PDF page.',
          502,
        );
      }
      const pageOne = parsePageDimensions((await poppler.execute(
        'inspectPageStdin', { page: 1 },
        runOptions(workspace, signal, 20_000, 512 * 1024, bytes),
      )).stdout, 1);
      const textPages = parseTextPages((await poppler.execute(
        'extractTextStdin', { layout: true },
        runOptions(workspace, signal, 30_000, 1024 * 1024, bytes),
      )).stdout, 1);
      const images = parseImages((await poppler.execute(
        'listImagesStdin', {},
        runOptions(workspace, signal, 30_000, 2 * 1024 * 1024, bytes),
      )).stdout);

      assertNotAborted(signal);
      await checkQuota();
      await assertStaged(input, identity, source, signal);
      await documents.verifySource(documentId);
      assertNotAborted(signal);
      return Object.freeze({ bytes, inspection, pageOne, textPages, images });
    },
  });
}
