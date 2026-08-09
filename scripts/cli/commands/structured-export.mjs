import {
  assertStructuredExportSourceSha256,
  buildValidatedStructuredExport,
  STRUCTURED_EXPORT_LIMITATIONS,
  validateStructuredExportRequest,
} from '../../host/structured-export-validation.mjs';

function fail(runtime, code, message) {
  if (typeof runtime.fail === 'function') runtime.fail(code, message);
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function verifySource(application, documentId, runtime) {
  if (typeof application?.store?.verifySource !== 'function') {
    fail(runtime, 'CLI_SOURCE_VERIFICATION_UNAVAILABLE', 'Structured export cannot verify the uploaded source.');
  }
  if (await application.store.verifySource(documentId) !== true) {
    fail(runtime, 'CLI_SOURCE_INTEGRITY_FAILED', 'Structured export source verification did not complete.');
  }
}

export async function runStructuredExportLocalCommand(application, command, document, stdout, signal, runtime) {
  const { cancelled, canonicalOutputTarget, emit, writeExclusiveVerified } = runtime;
  if (!document?.id || !assertStructuredExportSourceSha256(document.sha256)) {
    fail(runtime, 'CLI_INVALID_STRUCTURED_EXPORT', 'Structured export requires an uploaded source-bound PDF document.');
  }
  const request = validateStructuredExportRequest(command);
  await canonicalOutputTarget(command.output);
  cancelled(signal);
  await verifySource(application, document.id, runtime);
  cancelled(signal);
  if (typeof application?.service?.inspect !== 'function' || typeof application?.service?.extractText !== 'function') {
    fail(runtime, 'CLI_STRUCTURED_EXPORT_UNAVAILABLE', 'The installed PDF inspection service is unavailable.');
  }
  const inspection = await application.service.inspect(document.id, { signal });
  cancelled(signal);
  const exportedPages = await application.service.extractText(document.id, inspection?.pageCount, { signal });
  cancelled(signal);
  await verifySource(application, document.id, runtime);
  cancelled(signal);
  const exported = buildValidatedStructuredExport({
    pages: exportedPages,
    pageCount: inspection?.pageCount,
    format: request.format,
    title: document.displayName,
  });
  await writeExclusiveVerified(command.output, exported.bytes, signal, async (receipt) => {
    if (receipt.size !== exported.bytes.length || receipt.sha256 !== exported.outputSha256) {
      fail(runtime, 'CLI_OUTPUT_VERIFICATION_FAILED', 'Structured export publication receipt does not match the validated bytes.');
    }
    await verifySource(application, document.id, runtime);
    cancelled(signal);
    await emit(stdout, Object.freeze({
      kind: 'structured-export-local',
      format: exported.format,
      mediaType: exported.mediaType,
      sourceSha256: document.sha256,
      output: Object.freeze({
        extension: exported.extension,
        size: receipt.size,
        sha256: receipt.sha256,
        mediaType: exported.mediaType,
      }),
      pageCount: exported.pageCount,
      aggregateTextBytes: exported.aggregateTextBytes,
      aggregateTextSha256: exported.aggregateTextSha256,
      limitations: STRUCTURED_EXPORT_LIMITATIONS,
      localOnly: true,
    }));
  });
}
