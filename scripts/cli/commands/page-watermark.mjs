import { basename } from 'node:path';
import { PDF_PAGE_WATERMARK_PROFILE } from '../../host/pdf-page-watermark-contract.mjs';
import { PDF_PAGE_WATERMARK_LIMITATIONS } from '../../host/pdf-page-watermark-job.mjs';

const ARTIFACT_FIELDS = Object.freeze([
  'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'createdAt',
]);
const EVIDENCE_FIELDS = Object.freeze([
  'sourceDigestReverified', 'sourcePrefixPreserved', 'watermarkTextEffectProven',
  'onlySelectedPagesChanged', 'pageBoxesPreserved', 'resourcesPreserved',
  'annotationsPreserved', 'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);

function safeArtifact(value, output) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { output: basename(output) };
  const artifact = Object.fromEntries(ARTIFACT_FIELDS.filter((field) => {
    if (!Object.hasOwn(value, field)) return false;
    if (field === 'displayName') return value[field] === 'page-watermarked.pdf';
    if (field === 'sha256') return typeof value[field] === 'string' && /^[0-9a-f]{64}$/u.test(value[field]);
    if (field === 'mediaType') return value[field] === 'application/pdf';
    if (field === 'size') return Number.isSafeInteger(value[field]) && value[field] >= 0;
    return typeof value[field] === 'string' && !/[\\/\0]/u.test(value[field]);
  }).map((field) => [field, value[field]]));
  artifact.output = basename(output);
  return artifact;
}

function safeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const evidence = Object.fromEntries(EVIDENCE_FIELDS
    .filter((field) => Object.hasOwn(value, field) && typeof value[field] === 'boolean')
    .map((field) => [field, value[field]]));
  return Object.keys(evidence).length ? evidence : undefined;
}

function safePages(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && Number.isSafeInteger(entry.page) && entry.page >= 1 && typeof entry.applied === 'boolean')
    .map((entry) => ({ page: entry.page, applied: entry.applied }));
}

function receipt(result, output) {
  const value = {
    kind: 'pdf-page-watermark',
    profile: PDF_PAGE_WATERMARK_PROFILE,
    pages: safePages(result?.pages),
    artifact: safeArtifact(result?.artifact, output),
    localOnly: true,
    sourceBound: true,
  };
  const evidence = safeEvidence(result?.evidence);
  if (evidence) value.evidence = evidence;
  value.limitations = [...PDF_PAGE_WATERMARK_LIMITATIONS];
  return Object.freeze(value);
}

export async function runPageWatermarkCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const service = application.pageWatermark;
  if (!service || typeof service.create !== 'function') {
    runtime.fail('CLI_PAGE_WATERMARK_UNAVAILABLE', 'Page watermark is unavailable.');
  }
  let result = null;
  try {
    result = await service.create(document.id, {
      profile: PDF_PAGE_WATERMARK_PROFILE,
      sourceSha256: document.sha256,
      pages: command.pages,
      text: command.text,
    }, { sourceSha256: document.sha256, signal });
    runtime.cancelled(signal);
    const artifact = application.store.getArtifact(result.artifact.id);
    await runtime.copyExclusive(artifact.filePath, command.output, signal);
    runtime.cancelled(signal);
    await runtime.emit(stdout, receipt(result, command.output));
  } catch (error) {
    if (result?.artifact?.id && typeof application.store?.deleteArtifact === 'function') {
      await application.store.deleteArtifact(result.artifact.id).catch(() => {});
    }
    throw error;
  }
}
