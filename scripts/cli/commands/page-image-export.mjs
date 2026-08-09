import { basename } from 'node:path';
import {
  sha256,
  validatePageInspection,
  validatePagePng,
  verifyRetainedSource,
} from '../../host/page-png-export-validation.mjs';

const LIMITATIONS = Object.freeze([
  'Raster PNG output only; text, vector, and PDF object extraction are not claimed.',
  'Pixel, color, typography, and general format fidelity are not claimed.',
]);

function invalid(runtime, code, message) {
  runtime.fail(code, message);
}

export async function runPageImageExportCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const service = application.service;
  if (!service || typeof service.inspect !== 'function' || typeof service.renderThumbnail !== 'function') {
    invalid(runtime, 'CLI_PAGE_IMAGE_EXPORT_UNAVAILABLE', 'Page PNG export is unavailable.');
  }
  const dpi = command.dpi;
  if (!Number.isSafeInteger(dpi) || ![72, 150].includes(dpi)) {
    invalid(runtime, 'CLI_INVALID_DPI', 'Page PNG export DPI must be 72 or 150.');
  }
  const requestedPage = command.page;
  await verifyRetainedSource(application.store, document);
  runtime.cancelled(signal);
  const inspection = await service.inspect(document.id, { signal });
  const { page, pageCount } = validatePageInspection(inspection, requestedPage);
  runtime.cancelled(signal);
  const png = await service.renderThumbnail(document.id, { page, dpi, signal });
  runtime.cancelled(signal);
  const checked = validatePagePng(png);
  await verifyRetainedSource(application.store, document);
  runtime.cancelled(signal);
  const outputSha256 = sha256(png);
  if (outputSha256 !== checked.sha256) {
    invalid(runtime, 'CLI_INVALID_ENGINE_OUTPUT', 'Page export PNG digest changed during validation.');
  }
  await runtime.writeExclusiveVerified(command.output, png, signal, async (receipt) => {
    if (!receipt || receipt.size !== checked.size || receipt.sha256 !== checked.sha256) {
      invalid(runtime, 'CLI_OUTPUT_VERIFICATION_FAILED', 'Published PNG receipt does not match validated bytes.');
    }
    runtime.cancelled(signal);
    await verifyRetainedSource(application.store, document);
    runtime.cancelled(signal);
    await runtime.emit(stdout, {
      kind: 'page-image-export',
      output: basename(command.output),
      sourceSha256: document.sha256,
      page,
      pageCount,
      dpi,
      size: checked.size,
      sha256: checked.sha256,
      width: checked.width,
      height: checked.height,
      mediaType: checked.mediaType,
      limitations: LIMITATIONS,
      localOnly: true,
    });
  });
}
