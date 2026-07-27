import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { basename } from 'node:path';
import { OPAQUE_ID, SHA256 } from '../../host/document-store-contract.mjs';
import { PDF_COPY_PAGE_PROFILE } from '../../host/pdf-copy-page-contract.mjs';

const MEDIA_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.tif': 'image/tiff', '.tiff': 'image/tiff' });
const MAX_SCAN_BYTES = 256 * 1024 * 1024;

function trustedInput(application, value, source, command, runtime) {
  if (!value || !OPAQUE_ID.test(value.id ?? '') || value.size !== source.bytes.length || value.sha256 !== source.sha256 || value.extension !== command.extension || value.mediaType !== MEDIA_TYPES[command.extension]) runtime.fail('CLI_INVALID_INPUT_RECORD', 'The private scan input record is inconsistent.');
  let authoritative;
  try { authoritative = application.inputs.getInput(value.id); } catch { runtime.fail('CLI_INVALID_INPUT_RECORD', 'The private scan input record could not be re-read safely.'); }
  if (!authoritative || authoritative.id !== value.id || authoritative.size !== value.size || authoritative.sha256 !== value.sha256 || authoritative.extension !== value.extension || authoritative.mediaType !== value.mediaType) runtime.fail('CLI_INVALID_INPUT_RECORD', 'The private scan input record changed before conversion.');
  return Object.freeze(authoritative);
}

function trustedConvertedDocument(application, value, asset, runtime) {
  if (!value || !OPAQUE_ID.test(value.id ?? '') || !SHA256.test(value.sha256 ?? '') || !Number.isSafeInteger(value.size) || !value.operation?.validation?.passed || value.operation.validation.pageCount !== 1 || !value.operation.inputs?.some((input) => input?.assetId === asset.id && input?.sha256 === asset.sha256)) runtime.fail('CLI_INVALID_SCAN_OUTPUT', 'The conversion did not return a source-bound one-page PDF record.');
  let authoritative;
  try { authoritative = application.store.getDocument(value.id); } catch { runtime.fail('CLI_INVALID_SCAN_OUTPUT', 'The converted scan document could not be re-read safely.'); }
  if (!authoritative || authoritative.id !== value.id || authoritative.sha256 !== value.sha256 || authoritative.size !== value.size || !authoritative.operation?.validation?.passed || authoritative.operation.validation.pageCount !== 1 || !authoritative.operation.inputs?.some((input) => input?.assetId === asset.id && input?.sha256 === asset.sha256)) runtime.fail('CLI_INVALID_SCAN_OUTPUT', 'The converted scan document changed or lost its source binding.');
  return Object.freeze(authoritative);
}

function trustedArtifact(application, value, primaryDocument, runtime) {
  if (!value || !OPAQUE_ID.test(value.id ?? '') || value.documentId !== primaryDocument.id || value.mediaType !== 'application/pdf' || !Number.isSafeInteger(value.size) || value.size < 1 || !SHA256.test(value.sha256 ?? '')) runtime.fail('CLI_INVALID_SCAN_OUTPUT', 'The copy-page service returned an invalid derived artifact.');
  let authoritative;
  try { authoritative = application.store.getArtifact(value.id); } catch { runtime.fail('CLI_INVALID_SCAN_OUTPUT', 'The derived scan artifact could not be re-read safely.'); }
  if (!authoritative || authoritative.id !== value.id || authoritative.documentId !== value.documentId || authoritative.mediaType !== value.mediaType || authoritative.size !== value.size || authoritative.sha256 !== value.sha256 || typeof authoritative.filePath !== 'string' || !authoritative.filePath) runtime.fail('CLI_INVALID_SCAN_OUTPUT', 'The promoted scan artifact changed before publication.');
  return Object.freeze(authoritative);
}

async function cleanup(application, { asset, converted, artifact }) {
  const tasks = [
    asset?.id ? () => application.inputs.deleteInput(asset.id) : null,
    converted?.id ? () => application.store.deleteDocument(converted.id) : null,
    artifact?.id ? () => application.store.deleteArtifact(artifact.id) : null,
  ].filter(Boolean);
  const outcomes = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  return outcomes.filter(({ status, reason }) => status === 'rejected' && !['INPUT_NOT_FOUND', 'DOCUMENT_NOT_FOUND', 'ARTIFACT_NOT_FOUND'].includes(reason?.code)).map(({ reason }) => reason);
}

export async function runScanAppendCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const source = await runtime.readLocalInputBytes(command.scan, { minimumBytes: 8, maximumBytes: MAX_SCAN_BYTES, extension: command.extension, signal });
  const sourceSha256 = createHash('sha256').update(source.bytes).digest('hex');
  const sourceRecord = Object.freeze({ ...source, sha256: sourceSha256 });
  let asset = null; let converted = null; let artifact = null; let primaryError = null;
  try {
    const createdAsset = await application.inputs.createInput({ stream: Readable.from([sourceRecord.bytes]), displayName: sourceRecord.displayName, mediaType: MEDIA_TYPES[command.extension] });
    asset = trustedInput(application, createdAsset, sourceRecord, command, runtime);
    await application.inputs.verifyInput(asset.id);
    runtime.cancelled(signal);
    const createdDocument = await application.conversion.convertInput(asset.id, { signal });
    converted = trustedConvertedDocument(application, createdDocument, asset, runtime);
    runtime.cancelled(signal);
    const request = Object.freeze({ profile: PDF_COPY_PAGE_PROFILE, primarySourceSha256: document.sha256, secondarySourceSha256: converted.sha256, sourcePage: 1, afterPage: command.afterPage });
    const copied = await application.service.copyPageBetweenDocuments(document.id, converted.id, request, { signal });
    artifact = trustedArtifact(application, copied, document, runtime);
    runtime.cancelled(signal);
    await runtime.copyExclusive(artifact.filePath, command.output, signal);
    await runtime.emit(stdout, { kind: 'scan-append', output: basename(command.output), source: { format: command.extension.slice(1), size: sourceRecord.bytes.length, sha256: sourceRecord.sha256 }, converted: { pages: 1, sha256: converted.sha256 }, artifact: { size: artifact.size, sha256: artifact.sha256 }, afterPage: command.afterPage, localOnly: true });
  } catch (error) { primaryError = error; }
  finally { sourceRecord.bytes.fill(0); }
  const cleanupFailures = await cleanup(application, { asset, converted, artifact });
  if (primaryError && cleanupFailures.length) throw new AggregateError([primaryError, ...cleanupFailures], 'Scan append failed and temporary-resource cleanup also failed.');
  if (primaryError) throw primaryError;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, 'Scan append completed but temporary-resource cleanup failed.');
}
