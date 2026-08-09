import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { validateOperationProvenance } from '../../host/operation-provenance.mjs';
import {
  MAX_POSTSCRIPT_PDF_EXPORT_BYTES,
  MAX_POSTSCRIPT_PDF_EXPORT_PAGES,
} from '../../host/conversion-postscript-export.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PAGE_POINTS = 14_400;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const FIDELITY_EXCLUSIONS = Object.freeze([
  'PostScript operators, fonts, transparency, and unsupported embedded resources are interpreted by Ghostscript; exact source fidelity is not certified.',
  'The bounded export checks page geometry, extracted text, and passive PDF indicators; visual equivalence is not certified.',
]);

function invalid(runtime, message, code = 'CLI_INVALID_POSTSCRIPT_CONVERSION') {
  runtime.fail(code, message);
}

function exactValidators(value) {
  return Array.isArray(value)
    && value.length === 3
    && value[0] === 'source-sha256'
    && value[1] === 'ghostscript-exit-zero'
    && value[2] === 'pdfinfo-page-count';
}

function assertInputAsset(asset, source, extension, runtime) {
  const valid = asset
    && OPAQUE_ID.test(asset.id ?? '')
    && asset.displayName === source.displayName
    && asset.mediaType === 'application/postscript'
    && asset.kind === 'postscript'
    && asset.extension === extension
    && asset.size === source.bytes.length
    && asset.sha256 === source.sha256;
  if (!valid) invalid(runtime, 'The private PostScript input record is inconsistent.', 'CLI_INVALID_INPUT_RECORD');
}

function assertConversionProvenance(document, asset, extension, runtime) {
  let operation;
  try {
    operation = validateOperationProvenance(document?.operation);
  } catch {
    invalid(runtime, 'PostScript conversion returned invalid operation provenance.');
  }
  const input = operation.inputs[0];
  const parameters = operation.parameters;
  const pageCount = operation.validation?.pageCount;
  const valid = OPAQUE_ID.test(document?.id ?? '')
    && document?.origin === 'derived'
    && document.mediaType === 'application/pdf'
    && Number.isSafeInteger(document.size)
    && document.size >= 5
    && document.size <= MAX_POSTSCRIPT_PDF_EXPORT_BYTES
    && SHA256.test(document.sha256 ?? '')
    && operation.type === 'postscript-to-pdf'
    && operation.inputs.length === 1
    && input?.assetId === asset.id
    && input.sha256 === asset.sha256
    && input.role === 'source'
    && parameters.sourceFormat === extension.slice(1)
    && parameters.sourceKind === 'postscript'
    && operation.expected.minimumPageCount === 1
    && operation.validation.passed === true
    && Number.isSafeInteger(pageCount)
    && pageCount >= 1 && pageCount <= MAX_POSTSCRIPT_PDF_EXPORT_PAGES
    && exactValidators(operation.validation.validators);
  if (!valid) invalid(runtime, 'PostScript conversion provenance does not match the fixed local profile.');
  return pageCount;
}

function assertExportEvidence(evidence, document, runtime) {
  const evidenceKeys = evidence && typeof evidence === 'object' ? Reflect.ownKeys(evidence) : [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidenceKeys.length !== 4
    || !['bytes', 'inspection', 'pages', 'textPages'].every((key) => evidenceKeys.includes(key))
    || !Buffer.isBuffer(evidence.bytes)) {
    invalid(runtime, 'The PostScript PDF export did not return bounded PDF bytes.');
  }
  const { bytes, inspection, pages, textPages } = evidence;
  const pageCount = inspection?.pageCount;
  const indicators = String(inspection?.encrypted).toLowerCase() === 'no'
    && String(inspection?.javascript).toLowerCase() === 'no'
    && String(inspection?.form).toLowerCase() === 'none';
  const geometry = Array.isArray(pages)
    && pages.length === pageCount
    && pages.every((page, index) => page?.page === index + 1
      && Number.isFinite(page.widthPoints) && page.widthPoints > 0
      && page.widthPoints <= MAX_PAGE_POINTS
      && Number.isFinite(page.heightPoints) && page.heightPoints > 0
      && page.heightPoints <= MAX_PAGE_POINTS);
  let textBytes = 0;
  const textValid = Array.isArray(textPages)
    && textPages.length === pageCount
    && textPages.every((page, index) => {
      if (page?.page !== index + 1 || typeof page.text !== 'string') return false;
      textBytes += Buffer.byteLength(page.text, 'utf8') + (index ? 1 : 0);
      return textBytes <= MAX_TEXT_BYTES;
    });
  const valid = Number.isSafeInteger(pageCount)
    && pageCount >= 1 && pageCount <= MAX_POSTSCRIPT_PDF_EXPORT_PAGES
    && bytes.length === document.size
    && createHash('sha256').update(bytes).digest('hex') === document.sha256
    && indicators && geometry && textValid;
  if (!valid) invalid(runtime, 'The PostScript PDF export failed the fixed independent checks.');
  const text = textPages.map((page) => page.text).join('\n');
  return Object.freeze({
    pageCount,
    pages: Object.freeze(pages.map(({ page, widthPoints, heightPoints }) => Object.freeze({ page, widthPoints, heightPoints }))),
    textNonEmptyPages: textPages.filter(({ text: value }) => value.trim().length > 0).length,
    textBytes: Buffer.byteLength(text, 'utf8'),
    textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    indicators: Object.freeze({ encrypted: 'no', javascript: 'no', form: 'none' }),
  });
}

function conversionCleanupFailure(original, cleanupError) {
  const error = new Error('PostScript conversion failed and its private derived document could not be revoked.');
  error.code = 'CLI_CONVERSION_CLEANUP_FAILED';
  error.cause = new AggregateError([original, cleanupError], 'PostScript conversion and derived document cleanup failed.');
  return error;
}

function assertPublishedReceipt(receipt, size, sha256, runtime) {
  const keys = receipt && typeof receipt === 'object' ? Reflect.ownKeys(receipt) : [];
  const valid = receipt && typeof receipt === 'object'
    && Object.isFrozen(receipt)
    && (Object.getPrototypeOf(receipt) === Object.prototype || Object.getPrototypeOf(receipt) === null)
    && keys.length === 2 && keys.includes('size') && keys.includes('sha256')
    && Number.isSafeInteger(receipt.size) && receipt.size === size
    && receipt.sha256 === sha256;
  if (!valid) invalid(runtime, 'The published PDF receipt does not match the validated derived bytes.');
}

export async function runPostScriptConversionCommand(application, command, stdout, signal, runtime) {
  const { cancelled, canonicalOutputTarget, emit, readLocalInputBytes, writeExclusiveVerified } = runtime;
  const extension = extname(command.input).toLowerCase();
  if (!['.ps', '.eps'].includes(extension)) invalid(runtime, 'The selected local input must use the .ps or .eps extension.');
  await canonicalOutputTarget(command.output);
  const selected = await readLocalInputBytes(command.input, {
    minimumBytes: 5,
    maximumBytes: MAX_POSTSCRIPT_PDF_EXPORT_BYTES,
    signal,
  });
  cancelled(signal);
  const source = Object.freeze({
    ...selected,
    sha256: createHash('sha256').update(selected.bytes).digest('hex'),
  });
  const asset = await application.inputs.createInput({
    stream: Readable.from([source.bytes]),
    displayName: source.displayName,
    mediaType: 'application/postscript',
  });
  assertInputAsset(asset, source, extension, runtime);
  await application.inputs.verifyInput(asset.id);
  cancelled(signal);
  let validatedDocumentId = null;
  try {
    const document = await application.conversion.convertInput(asset.id, { signal });
    const provenancePages = assertConversionProvenance(document, asset, extension, runtime);
    validatedDocumentId = document.id;
    cancelled(signal);
    const evidence = await application.conversion.preparePostScriptPdfExport(
      document.id, { signal },
    );
    const checked = assertExportEvidence(evidence, document, runtime);
    if (checked.pageCount !== provenancePages) invalid(runtime, 'PostScript PDF page count changed after conversion.');
    const pdfSha256 = createHash('sha256').update(evidence.bytes).digest('hex');
    await writeExclusiveVerified(command.output, evidence.bytes, signal, async (receipt) => {
      assertPublishedReceipt(receipt, evidence.bytes.length, pdfSha256, runtime);
      cancelled(signal);
      await emit(stdout, {
        kind: 'postscript-to-pdf',
        output: basename(command.output),
        source: { format: extension.slice(1), size: source.bytes.length, sha256: source.sha256 },
        pdf: { size: evidence.bytes.length, sha256: pdfSha256, pages: checked.pageCount },
        pageGeometry: checked.pages,
        text: {
          pageCount: checked.pageCount,
          nonEmptyPages: checked.textNonEmptyPages,
          aggregateBytes: checked.textBytes,
          aggregateSha256: checked.textSha256,
        },
        passiveIndicators: checked.indicators,
        fidelityExclusions: FIDELITY_EXCLUSIONS,
        localOnly: true,
      });
    });
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
