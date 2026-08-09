import { basename } from 'node:path';
import { normalizePdfPageHeaderFooter } from '../../host/pdf-page-header-footer-contract.mjs';

const CAPABILITY_ID = 'edit.headers-footers';
const INVALID_REQUEST_CODE = 'CLI_INVALID_PROFESSIONAL_HEADER_FOOTER_REQUEST';
const INVALID_RECEIPT_CODE = 'PROFESSIONAL_HEADER_FOOTER_RECEIPT_INVALID';

function privacySafeReceipt(result, output) {
  const artifact = result?.artifact;
  return Object.freeze({
    capabilityId: CAPABILITY_ID,
    ...(typeof result?.profile === 'string' ? { profile: result.profile } : {}),
    ...(typeof result?.method === 'string' ? { method: result.method } : {}),
    ...(typeof result?.outputSha256 === 'string' ? { outputSha256: result.outputSha256 } : {}),
    artifact: artifact && typeof artifact === 'object' && !Array.isArray(artifact)
      ? Object.freeze({
        ...(typeof artifact.id === 'string' ? { id: artifact.id } : {}),
        ...(typeof artifact.documentId === 'string' ? { documentId: artifact.documentId } : {}),
        ...(typeof artifact.mediaType === 'string' ? { mediaType: artifact.mediaType } : {}),
        ...(Number.isSafeInteger(artifact.size) ? { size: artifact.size } : {}),
        ...(typeof artifact.sha256 === 'string' ? { sha256: artifact.sha256 } : {}),
        output: basename(output),
      })
      : null,
  });
}

export async function runSourceBoundHeaderFooterEdit(application, command, stdout, signal, runtime) {
  const deliver = application.professionalCapabilities?.deliverContentEditingSourceBound;
  if (typeof deliver !== 'function') runtime.fail('PROFESSIONAL_HEADER_FOOTER_EDIT_UNAVAILABLE', 'Source-bound professional header/footer delivery is unavailable.');
  const document = await runtime.uploadPdf(application, command.input, signal);
  runtime.cancelled(signal);
  const selected = await runtime.readLocalInputBytes(command.requestPath, {
    minimumBytes: 2,
    maximumBytes: 128 * 1024,
    extension: '.json',
    signal,
  });
  let request;
  try {
    request = normalizePdfPageHeaderFooter(JSON.parse(selected.bytes.toString('utf8')));
  } catch {
    runtime.fail(INVALID_REQUEST_CODE, 'The professional header/footer request file is invalid or outside the bounded contract.');
  } finally {
    selected.bytes.fill(0);
  }
  if (request.sourceSha256 !== document.sha256) {
    runtime.fail('SOURCE_VERSION_MISMATCH', 'The professional header/footer request digest does not match the uploaded source.');
  }
  runtime.cancelled(signal);
  let trustedArtifactId = null;
  let operationError = null;
  try {
    const result = await deliver(CAPABILITY_ID, document.id, request, { signal });
    const artifact = result?.artifact;
    const candidateId = artifact?.id ?? null;
    runtime.cancelled(signal);
    if (!candidateId) runtime.fail(INVALID_RECEIPT_CODE, 'Professional header/footer delivery did not return a retained artifact.');
    const retained = application.store.getArtifact(candidateId);
    if (!retained || retained.id !== artifact.id || retained.documentId !== document.id
      || retained.mediaType !== artifact.mediaType || retained.size !== artifact.size
      || retained.sha256 !== artifact.sha256 || retained.sha256 !== result.outputSha256) {
      runtime.fail(INVALID_RECEIPT_CODE, 'The retained professional header/footer artifact does not match the validated receipt.');
    }
    trustedArtifactId = retained.id;
    await runtime.copyExclusive(retained.filePath, command.output, signal);
    runtime.cancelled(signal);
    await runtime.emit(stdout, privacySafeReceipt(result, command.output));
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  if (trustedArtifactId) {
    try { await application.store.deleteArtifact(trustedArtifactId); } catch (error) { cleanupError = error; }
  }
  if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], 'Professional header/footer delivery and artifact cleanup failed.');
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
}
