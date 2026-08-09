import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { validateOperationProvenance } from '../../host/operation-provenance.mjs';
import {
  decodePng,
  encodeRgbaPng,
  MAX_PNG_INPUT_BYTES,
} from '../../host/raster-png-codec.mjs';
import { MAX_PNG_PDF_EXPORT_BYTES } from '../../host/conversion-png-export.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PAGE_POINTS = 14_400;
const LIMITATIONS = Object.freeze([
  'The PNG is normalized to bounded metadata-free 8-bit RGBA before local conversion.',
  'PNG profiles, ancillary metadata, animation, and non-RGB color models are not preserved.',
  'Dimensions and bounded PDF structure are checked; exact pixel and color fidelity are not certified.',
]);

function invalid(runtime, message, code = 'CLI_INVALID_CONVERTED_PDF') {
  runtime.fail(code, message);
}

function normalizePng(bytes, runtime) {
  try {
    const decoded = decodePng(bytes);
    const normalized = encodeRgbaPng(decoded);
    return Object.freeze({
      width: decoded.width,
      height: decoded.height,
      bytes: normalized,
      sha256: createHash('sha256').update(normalized).digest('hex'),
    });
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED') throw error;
    invalid(
      runtime,
      'The selected PNG is not a supported bounded non-interlaced 8-bit RGB or RGBA image.',
      'CLI_UNSUPPORTED_PNG',
    );
  }
}

function assertInputAsset(asset, source, runtime) {
  const valid = asset
    && OPAQUE_ID.test(asset.id ?? '')
    && asset.displayName === source.displayName
    && asset.mediaType === 'image/png'
    && asset.kind === 'image'
    && asset.extension === '.png'
    && asset.size === source.bytes.length
    && asset.sha256 === source.sha256;
  if (!valid) invalid(runtime, 'The private PNG input record is inconsistent.', 'CLI_INVALID_INPUT_RECORD');
}

function exactValidators(value) {
  return Array.isArray(value)
    && value.length === 3
    && new Set(value).size === 3
    && ['source-sha256', 'imagemagick-exit-zero', 'pdfinfo-page-count']
      .every((validator) => value.includes(validator));
}

function assertConversionProvenance(document, asset, normalized, runtime) {
  let operation;
  try {
    operation = validateOperationProvenance(document?.operation);
  } catch {
    invalid(runtime, 'PNG conversion returned invalid operation provenance.');
  }
  const input = operation.inputs[0];
  const parameters = operation.parameters;
  const valid = OPAQUE_ID.test(document?.id ?? '')
    && document?.origin === 'derived'
    && document.mediaType === 'application/pdf'
    && Number.isSafeInteger(document.size)
    && document.size >= 64
    && document.size <= MAX_PNG_PDF_EXPORT_BYTES
    && SHA256.test(document.sha256 ?? '')
    && operation.type === 'image-to-pdf'
    && operation.inputs.length === 1
    && input?.assetId === asset.id
    && input.sha256 === asset.sha256
    && input.role === 'source'
    && parameters.sourceFormat === 'png'
    && parameters.sourceKind === 'image'
    && parameters.sourceWidthPixels === normalized.width
    && parameters.sourceHeightPixels === normalized.height
    && parameters.normalizedSha256 === normalized.sha256
    && operation.expected.minimumPageCount === 1
    && operation.validation.passed === true
    && operation.validation.pageCount === 1
    && exactValidators(operation.validation.validators);
  if (!valid) invalid(runtime, 'PNG conversion provenance does not match the fixed local profile.');
}

function assertPublishedReceipt(receipt, size, sha256, runtime) {
  const isRecord = receipt !== null && typeof receipt === 'object';
  const keys = isRecord ? Reflect.ownKeys(receipt) : [];
  const valid = isRecord
    && Object.isFrozen(receipt)
    && (Object.getPrototypeOf(receipt) === Object.prototype
      || Object.getPrototypeOf(receipt) === null)
    && keys.length === 2
    && keys.includes('size')
    && keys.includes('sha256')
    && Number.isSafeInteger(receipt.size)
    && receipt.size === size
    && receipt.sha256 === sha256;
  if (!valid) {
    invalid(runtime, 'The published PDF receipt does not match the validated derived bytes.');
  }
}

function conversionCleanupFailure(original, cleanupError) {
  const error = new Error(
    'PNG conversion failed and its private derived document could not be revoked.',
  );
  error.code = 'CLI_CONVERSION_CLEANUP_FAILED';
  error.cause = new AggregateError(
    [original, cleanupError],
    'PNG conversion and derived document cleanup failed.',
  );
  return error;
}

function assertExportEvidence(evidence, normalized, runtime) {
  const { inspection, pageOne, textPages, images } = evidence;
  const indicators = String(inspection?.encrypted).toLowerCase() === 'no'
    && String(inspection?.javascript).toLowerCase() === 'no'
    && String(inspection?.form).toLowerCase() === 'none';
  const geometry = pageOne?.page === 1
    && Number.isFinite(pageOne.widthPoints) && pageOne.widthPoints > 0
    && pageOne.widthPoints <= MAX_PAGE_POINTS
    && Number.isFinite(pageOne.heightPoints) && pageOne.heightPoints > 0
    && pageOne.heightPoints <= MAX_PAGE_POINTS;
  const textEmpty = Array.isArray(textPages)
    && textPages.length === 1
    && textPages[0]?.page === 1
    && typeof textPages[0].text === 'string'
    && textPages[0].text.trim().length === 0;
  const primary = Array.isArray(images)
    ? images.filter((image) => image?.type === 'image')
    : [];
  const masks = Array.isArray(images)
    ? images.filter((image) => image?.type === 'smask')
    : [];
  const imageInventory = images?.length === primary.length + masks.length
    && primary.length === 1
    && masks.length <= 1
    && images.every((image) => image.page === 1
      && image.width === normalized.width
      && image.height === normalized.height
      && image.bitsPerComponent === 8)
    && primary[0]?.color === 'rgb';
  if (inspection?.pageCount !== 1 || !indicators || !geometry
    || !textEmpty || !imageInventory) {
    invalid(runtime, 'The derived PNG PDF failed the fixed independent export checks.');
  }
}

export async function runConversionCommand(
  application,
  command,
  stdout,
  signal,
  runtime,
) {
  const {
    cancelled,
    canonicalOutputTarget,
    emit,
    readLocalInputBytes,
  } = runtime;
  await canonicalOutputTarget(command.output);
  const selected = await readLocalInputBytes(command.input, {
    minimumBytes: 8,
    maximumBytes: MAX_PNG_INPUT_BYTES,
    extension: '.png',
    signal,
  });
  cancelled(signal);
  const sourceSha256 = createHash('sha256').update(selected.bytes).digest('hex');
  const source = Object.freeze({ ...selected, sha256: sourceSha256 });
  const normalized = normalizePng(source.bytes, runtime);
  cancelled(signal);
  const asset = await application.inputs.createInput({
    stream: Readable.from([source.bytes]),
    displayName: source.displayName,
    mediaType: 'image/png',
  });
  assertInputAsset(asset, source, runtime);
  await application.inputs.verifyInput(asset.id);
  cancelled(signal);
  let validatedDocumentId = null;
  try {
    const document = await application.conversion.convertInput(asset.id, { signal });
    assertConversionProvenance(document, asset, normalized, runtime);
    validatedDocumentId = document.id;
    cancelled(signal);
    const evidence = await application.conversion.preparePngPdfExport(
      document.id, { signal },
    );
    assertExportEvidence(evidence, normalized, runtime);
    const pdfSha256 = createHash('sha256').update(evidence.bytes).digest('hex');
    if (evidence.bytes.length !== document.size || pdfSha256 !== document.sha256) {
      invalid(runtime, 'The exported PDF bytes do not match the derived document record.');
    }
    cancelled(signal);
    await runtime.writeExclusiveVerified(
      command.output,
      evidence.bytes,
      signal,
      async (receipt) => {
        assertPublishedReceipt(receipt, evidence.bytes.length, pdfSha256, runtime);
        cancelled(signal);
        await emit(stdout, {
          kind: 'png-to-pdf',
          output: basename(command.output),
          source: {
            format: 'png',
            size: source.bytes.length,
            sha256: source.sha256,
            width: normalized.width,
            height: normalized.height,
          },
          normalization: {
            profile: 'bounded-rgba8-metadata-free-v1',
            size: normalized.bytes.length,
            sha256: normalized.sha256,
          },
          pdf: { pages: 1, size: evidence.bytes.length, sha256: pdfSha256 },
          validation: {
            passed: true,
            popplerIndicators: { encrypted: 'no', javascript: 'no', form: 'none' },
            textEmpty: true,
            primaryImageDimensionsMatch: true,
            sourceIntegrity: 'descriptor-bound-sha256',
          },
          limitations: LIMITATIONS,
          localOnly: true,
        });
      },
    );
  } catch (error) {
    if (!validatedDocumentId) throw error;
    try {
      await application.store.deleteDocument(validatedDocumentId);
    } catch (cleanupError) {
      throw conversionCleanupFailure(error, cleanupError);
    }
    throw error;
  }
}
