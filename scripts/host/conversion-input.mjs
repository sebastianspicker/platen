import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { extractFallbackTextFile } from './office-extractor.mjs';
import { createTextPdf } from './pdf-factory.mjs';
import {
  assertInlineOnlyHtml,
  canUseTextFallback,
  cleanConversionStem,
} from './conversion-admission.mjs';
import {
  inspectConversionOutput,
  MAX_CONVERSION_JOB_MS,
  runConversionJob,
} from './conversion-job-runtime.mjs';
import { readRegularOutput } from './bounded-output-io.mjs';
import {
  decodePng,
  encodeRgbaPng,
  MAX_PNG_INPUT_BYTES,
} from './raster-png-codec.mjs';

const MAX_CANONICAL_PNG_BYTES = 40 * 1024 * 1024;

const runOptions = (signal) => ({
  signal,
  timeoutMs: MAX_CONVERSION_JOB_MS,
  maxStdoutBytes: 256 * 1024,
  maxStderrBytes: 512 * 1024,
});

async function convertOfficeLike({ asset, input, output, workspace, signal, libreOffice }) {
  try {
    await libreOffice.execute(
      'convertOfficeToPdf', { input, output, workspace }, runOptions(signal),
    );
  } catch (error) {
    if (!canUseTextFallback(asset, error, signal)) throw error;
    const text = await extractFallbackTextFile(input, asset.extension);
    const bytes = createTextPdf({ text, title: asset.displayName });
    await writeFile(output, bytes, { mode: 0o600 });
  }
}

function assertNotAborted(signal) {
  if (!signal.aborted) return;
  const error = new Error('Image conversion was cancelled.');
  error.code = 'ENGINE_CANCELLED';
  throw error;
}

const SUPPORTED_NON_PNG_IMAGE_EXTENSIONS = Object.freeze(new Set(['.jpg', '.jpeg', '.tif', '.tiff']));

async function preparePngInput(asset, input, signal) {
  assertNotAborted(signal);
  if (asset.size > MAX_PNG_INPUT_BYTES) {
    throw new HostError(
      'PNG_INPUT_LIMIT',
      `Local PNG conversion input is limited to ${MAX_PNG_INPUT_BYTES} bytes.`,
      413,
    );
  }
  let sourceBytes;
  try {
    sourceBytes = await readRegularOutput(input, {
      minimumBytes: 8,
      maximumBytes: MAX_PNG_INPUT_BYTES,
      label: 'Local PNG conversion input',
    });
  } catch (error) {
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'The private PNG conversion input could not be read safely.',
      500,
      { cause: error },
    );
  }
  if (sourceBytes.length !== asset.size
    || createHash('sha256').update(sourceBytes).digest('hex') !== asset.sha256) {
    throw new HostError(
      'SOURCE_INTEGRITY_FAILED',
      'The PNG conversion input does not match its immutable asset record.',
      500,
    );
  }
  let decoded;
  try {
    decoded = decodePng(sourceBytes);
  } catch (error) {
    throw new HostError(
      'UNSUPPORTED_PNG_INPUT',
      'Local conversion accepts bounded non-interlaced 8-bit RGB or RGBA PNG input only.',
      415,
      { cause: error },
    );
  }
  assertNotAborted(signal);
  const normalized = encodeRgbaPng(decoded);
  if (normalized.length > MAX_CANONICAL_PNG_BYTES) {
    throw new HostError(
      'PNG_NORMALIZATION_LIMIT',
      'The canonical PNG exceeds the bounded local conversion limit.',
      413,
    );
  }
  assertNotAborted(signal);
  return Object.freeze({
    bytes: normalized,
    width: decoded.width,
    height: decoded.height,
    sha256: createHash('sha256').update(normalized).digest('hex'),
  });
}

async function convertByKind({ asset, input, workspace, signal, adapters, preparedPng }) {
  if (asset.kind === 'office' || asset.kind === 'text'
    || asset.kind === 'html' || asset.kind === 'cad') {
    const output = join(workspace, 'source.pdf');
    await convertOfficeLike({
      asset, input, output, workspace, signal, libreOffice: adapters.libreOffice,
    });
    const operationType = asset.kind === 'html'
      ? 'html-to-pdf' : asset.kind === 'cad' ? 'cad-to-pdf' : 'office-to-pdf';
    return { operationType, output };
  }
  if (asset.kind === 'image') {
    if (asset.extension === '.png' && !preparedPng) {
      throw new HostError(
        'INVALID_PNG_CONVERSION_STATE', 'PNG conversion input was not normalized.', 500,
      );
    }
    if (asset.extension === '.png') {
    const output = join(workspace, 'image.pdf');
    await adapters.imageMagick.execute(
      'convertPngStdinToPdf', { output, workspace }, {
        ...runOptions(signal),
        stdin: preparedPng.bytes,
        maxStdinBytes: MAX_CANONICAL_PNG_BYTES,
      },
    );
    return {
      operationType: 'image-to-pdf', output,
      producerValidator: 'imagemagick-exit-zero',
      operationParameters: {
        sourceWidthPixels: preparedPng.width,
        sourceHeightPixels: preparedPng.height,
        normalizedSha256: preparedPng.sha256,
      },
    };
    }
    if (!SUPPORTED_NON_PNG_IMAGE_EXTENSIONS.has(asset.extension)) {
      throw new HostError(
        'UNSUPPORTED_INPUT_FORMAT', 'Local raster-to-PDF conversion currently accepts PNG, JPEG, and TIFF input only.', 415,
      );
    }
    const output = join(workspace, 'image.pdf');
    await adapters.imageMagick.execute(
      'convertRasterToPdf', { input, output, workspace }, runOptions(signal),
    );
    return {
      operationType: 'image-to-pdf', output,
      producerValidator: 'imagemagick-exit-zero',
    };
  }
  if (asset.kind === 'postscript') {
    const output = join(workspace, 'postscript.pdf');
    const operation = asset.extension === '.eps'
      ? 'convertEpsToPdf' : 'convertPostScriptToPdf';
    await adapters.ghostscript.execute(
      operation, { input, output, workspace }, runOptions(signal),
    );
    return { operationType: 'postscript-to-pdf', output };
  }
  throw new HostError(
    'UNSUPPORTED_INPUT_FORMAT', 'No local converter is registered for this input.', 415,
  );
}

export async function convertInputAsset({
  assetId,
  externalSignal,
  inputs,
  documents,
  poppler,
  adapters,
}) {
  const asset = inputs.getInput(assetId);
  const input = inputs.getSourcePath(assetId);
  return runConversionJob({
    owner: inputs,
    resourceId: assetId,
    externalSignal,
    action: async ({ workspace, signal, checkQuota }) => {
      await inputs.verifyInput(assetId);
      if (asset.kind === 'html') assertInlineOnlyHtml(await readFile(input));
      const preparedPng = asset.kind === 'image' && asset.extension === '.png'
        ? await preparePngInput(asset, input, signal)
        : null;
      const converted = await convertByKind({
        asset, input, workspace, signal, adapters, preparedPng,
      });
      await checkQuota();
      await inputs.verifyInput(assetId);
      const inspection = await inspectConversionOutput(poppler, converted.output, signal);
      const operation = createOperationProvenance({
        type: converted.operationType,
        inputs: [{ assetId, sha256: asset.sha256, role: 'source' }],
        parameters: {
          sourceFormat: asset.extension.slice(1), sourceKind: asset.kind,
          ...(converted.operationParameters ?? {}),
        },
        expected: { minimumPageCount: 1 },
        validation: {
          passed: true,
          validators: [
            'source-sha256',
            ...(converted.producerValidator ? [converted.producerValidator] : []),
            'pdfinfo-page-count',
          ],
          pageCount: inspection.pageCount,
        },
      });
      return documents.createDocument({
        stream: createReadStream(converted.output),
        displayName: `${cleanConversionStem(asset.displayName)}.pdf`,
        operation,
      });
    },
  });
}
