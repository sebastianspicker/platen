import { join } from 'node:path';
import { createPdfkitRequestPath } from './adapters/pdfkit.mjs';
import { HostError } from './host-error.mjs';
import { parsePdfInfo } from './pdf-service-foundation.mjs';
import { stagePrivateSourceCopy } from './private-source-copy.mjs';
import { MAX_PDFKIT_SOURCE_BYTES } from './pdfkit-mutation-validation.mjs';

export async function stagePdfKitMutationSource({
  poppler,
  workspace,
  job,
  limits,
  source,
  storedSourcePath,
}) {
  const inputPath = join(workspace, 'input.pdf');
  const outputPath = join(workspace, 'output.pdf');
  const requestPath = createPdfkitRequestPath(workspace);
  let sourceCopyIdentity;
  try {
    sourceCopyIdentity = await stagePrivateSourceCopy({
      sourcePath: storedSourcePath,
      targetPath: inputPath,
      expectedSha256: source.sha256,
      expectedSize: source.size,
      maximumBytes: MAX_PDFKIT_SOURCE_BYTES,
    });
  } catch (error) {
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'PDFKit mutation could not bind a private immutable source copy.',
      500,
      { cause: error },
    );
  }
  const inspected = await poppler.execute(
    'inspect',
    { input: inputPath },
    {
      cwd: workspace,
      signal: job.signal,
      timeoutMs: limits.timeoutMs,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 128 * 1024,
    },
  );
  return Object.freeze({
    inputPath,
    outputPath,
    requestPath,
    sourceCopyIdentity,
    sourceInspection: parsePdfInfo(inspected.stdout),
  });
}
