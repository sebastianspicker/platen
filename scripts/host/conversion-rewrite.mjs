import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { cleanConversionStem } from './conversion-admission.mjs';
import {
  inspectConversionOutput,
  MAX_CONVERSION_JOB_MS,
  runConversionJob,
} from './conversion-job-runtime.mjs';

const REWRITE_OPERATIONS = Object.freeze({
  optimize: Object.freeze(['optimizePdf', 'optimize-pdf', 'optimized']),
  'flatten-transparency': Object.freeze([
    'flattenTransparency', 'flatten-transparency', 'flattened-transparency',
  ]),
  rewrite: Object.freeze(['rewritePdf', 'rewrite-pdf', 'rewritten']),
});

export async function rewritePdfDocument({
  documentId,
  mode,
  externalSignal,
  documents,
  poppler,
  ghostscript,
}) {
  const selected = REWRITE_OPERATIONS[mode];
  if (!selected) {
    throw new HostError('INVALID_CONVERSION_MODE', 'Unsupported PDF rewrite mode.', 400);
  }
  const source = documents.getDocument(documentId);
  const input = documents.getSourcePath(documentId);
  return runConversionJob({
    owner: documents,
    resourceId: documentId,
    externalSignal,
    action: async ({ workspace, signal, checkQuota }) => {
      const output = join(workspace, `${selected[2]}.pdf`);
      await documents.verifySource(documentId);
      const original = await inspectConversionOutput(poppler, input, signal);
      await ghostscript.execute(selected[0], { input, output, workspace }, {
        signal,
        timeoutMs: MAX_CONVERSION_JOB_MS,
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 512 * 1024,
      });
      await checkQuota();
      await documents.verifySource(documentId);
      const derived = await inspectConversionOutput(poppler, output, signal);
      if (derived.pageCount !== original.pageCount) {
        throw new HostError(
          'DERIVED_PAGE_COUNT_MISMATCH', 'The rewrite changed the PDF page count.', 502,
        );
      }
      const operation = createOperationProvenance({
        type: selected[1],
        inputs: [{ documentId, sha256: source.sha256, role: 'primary' }],
        parameters: { mode },
        expected: { pageCount: original.pageCount },
        validation: {
          passed: true,
          validators: ['source-sha256', 'pdfinfo-page-count'],
          pageCount: derived.pageCount,
        },
      });
      return documents.createDocument({
        stream: createReadStream(output),
        displayName: `${cleanConversionStem(source.displayName)}-${selected[2]}.pdf`,
        operation,
      });
    },
  });
}
