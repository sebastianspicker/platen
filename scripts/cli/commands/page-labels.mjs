import { basename } from 'node:path';
import { PDF_PAGE_LABELS_PROFILE, normalizePdfPageLabels } from '../../host/pdf-page-labels-contract.mjs';

export async function runPageLabelsCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const selected = await runtime.readLocalInputBytes(command.rangesPath, { minimumBytes: 2, maximumBytes: 128 * 1024, extension: '.json', signal });
  try {
    let ranges;
    try { ranges = JSON.parse(selected.bytes.toString('utf8')); } catch { runtime.fail('CLI_INVALID_RANGES', 'The page-label ranges file must be valid JSON.'); }
    if (!Array.isArray(ranges) || Object.getPrototypeOf(ranges) !== Array.prototype) runtime.fail('CLI_INVALID_RANGES', 'The page-label ranges file must contain only a canonical range array.');
    const request = { profile: PDF_PAGE_LABELS_PROFILE, sourceSha256: document.sha256, ranges };
    try { normalizePdfPageLabels(request); } catch { runtime.fail('CLI_INVALID_RANGES', 'The page-label ranges are outside the bounded canonical contract.'); }
    const result = await application.pageLabels.create(document.id, request, { sourceSha256: document.sha256, signal });
    runtime.cancelled(signal);
    const artifact = application.store.getArtifact(result.artifact.id);
    await runtime.copyExclusive(artifact.filePath, command.output);
    await runtime.emit(stdout, { ...result, artifact: { ...result.artifact, output: basename(command.output) }, localOnly: true });
  } finally { selected.bytes.fill(0); }
}
