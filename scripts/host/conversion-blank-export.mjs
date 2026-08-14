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

export const MAX_BLANK_EXPORT_BYTES = 1024 * 1024;
const MAX_BLANK_EXPORT_PAGES = 500;

function assertNotAborted(signal) {
  if (!signal.aborted) return;
  const error = new Error('Blank-PDF export validation was cancelled.');
  error.code = 'ENGINE_CANCELLED';
  throw error;
}

function runOptions(workspace, signal, timeoutMs, maxStdoutBytes) {
  return {
    cwd: workspace,
    signal,
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
      maximumBytes: MAX_BLANK_EXPORT_BYTES,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'Blank-PDF export could not bind the created source to a private snapshot.',
      500,
      { cause: error },
    );
  }
}

async function assertStagedSource(input, identity, source, signal) {
  assertNotAborted(signal);
  try {
    await assertPrivateSourceCopy({
      path: input,
      identity,
      expectedSha256: source.sha256,
      expectedSize: source.size,
      maximumBytes: MAX_BLANK_EXPORT_BYTES,
    });
  } catch (error) {
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'Blank-PDF export snapshot changed during local validation.',
      500,
      { cause: error },
    );
  }
}

export async function prepareBlankDocumentExport({
  documents,
  poppler,
  documentId,
  pages,
  externalSignal,
}) {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_BLANK_EXPORT_PAGES) {
    throw new HostError(
      'INVALID_BLANK_PAGE_COUNT',
      `Blank-PDF export requires between 1 and ${MAX_BLANK_EXPORT_PAGES} pages.`,
      400,
    );
  }
  const source = documents.getDocument(documentId);
  if (source.size < 64 || source.size > MAX_BLANK_EXPORT_BYTES) {
    throw new HostError(
      'INVALID_BLANK_DOCUMENT',
      'The created blank PDF is outside the bounded export size.',
      502,
    );
  }

  return runConversionJob({
    owner: documents,
    resourceId: documentId,
    externalSignal,
    action: async ({ workspace, signal, checkQuota }) => {
      const input = join(workspace, 'immutable-blank-source.pdf');
      await documents.verifySource(documentId);
      const identity = await stageSource(
        documents, documentId, source, input, signal,
      );
      await checkQuota();

      const bytes = await readRegularOutput(input, {
        minimumBytes: 64,
        maximumBytes: MAX_BLANK_EXPORT_BYTES,
        label: 'Created blank PDF snapshot',
      });
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== source.size || digest !== source.sha256) {
        throw new HostError(
          'SOURCE_INTEGRITY_FAILED',
          'Blank-PDF export bytes do not match the created source record.',
          500,
        );
      }
      await assertStagedSource(input, identity, source, signal);

      const inspection = parsePdfInfo((await poppler.execute(
        'inspectStdin',
        {},
        {
          ...runOptions(workspace, signal, 15_000, 512 * 1024),
          stdin: bytes,
        },
      )).stdout);
      const pageOne = parsePageDimensions((await poppler.execute(
        'inspectPageStdin',
        { page: 1 },
        {
          ...runOptions(workspace, signal, 15_000, 512 * 1024),
          stdin: bytes,
        },
      )).stdout, 1);
      const textPages = parseTextPages((await poppler.execute(
        'extractTextStdin',
        { layout: true },
        {
          ...runOptions(workspace, signal, 45_000, 32 * 1024 * 1024),
          stdin: bytes,
        },
      )).stdout, pages);

      assertNotAborted(signal);
      await checkQuota();
      await assertStagedSource(input, identity, source, signal);
      await documents.verifySource(documentId);
      assertNotAborted(signal);
      return Object.freeze({ bytes, inspection, pageOne, textPages });
    },
  });
}
