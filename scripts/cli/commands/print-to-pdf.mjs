import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { validateOperationProvenance } from '../../host/operation-provenance.mjs';
import {
  MAX_CUPS_PDF_BYTES, MAX_CUPS_PDF_PAGES, MAX_CUPS_TEXT_INPUT_BYTES,
} from '../../host/cups-print-to-pdf-service.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_POINTS = 14_400;
const MAX_TEXT = 8 * 1024 * 1024;
const VALIDATORS = ['source-sha256', 'cupsfilter-cgtexttopdf', 'pdfinfo-page-count', 'pdfinfo-passive'];
const FIDELITY_EXCLUSIONS = Object.freeze([
  'Printer selection, PPDs, copies, options, native dialogs, and physical printing are not supported.',
  'Layout, fonts, pagination, and visual fidelity are not certified.',
]);

function invalid(runtime, message, code = 'CLI_INVALID_CUPS_PRINT_TO_PDF') {
  runtime.fail(code, message);
}

function strictText(bytes, runtime) {
  if (bytes.includes(0)) invalid(runtime, 'The selected text input must not contain NUL bytes.', 'CLI_INVALID_TEXT_INPUT');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid(runtime, 'The selected text input must be strict UTF-8.', 'CLI_INVALID_TEXT_INPUT');
  }
}

function validAsset(asset, source) {
  return OPAQUE_ID.test(asset?.id ?? '') && asset.displayName === source.displayName
    && asset.mediaType === 'text/plain' && asset.kind === 'text' && asset.extension === '.txt'
    && asset.size === source.bytes.length && asset.sha256 === source.sha256;
}

function validateDocument(document, asset, runtime) {
  let operation;
  try { operation = validateOperationProvenance(document?.operation); } catch {
    invalid(runtime, 'Print-to-PDF returned invalid operation provenance.');
  }
  const input = operation.inputs[0];
  const parameters = operation.parameters;
  const valid = OPAQUE_ID.test(document?.id ?? '') && document?.origin === 'derived'
    && document.mediaType === 'application/pdf' && Number.isSafeInteger(document.size) && document.size >= 5
    && document.size <= MAX_CUPS_PDF_BYTES && SHA256.test(document.sha256 ?? '')
    && operation.type === 'cups-text-to-pdf' && operation.inputs.length === 1
    && input?.assetId === asset.id && input.sha256 === asset.sha256 && input.role === 'source'
    && parameters?.sourceFormat === 'txt' && parameters.sourceMediaType === 'text/plain'
    && parameters.filter === 'cgtexttopdf' && operation.validation?.passed === true
    && operation.validation?.pageCount >= 1 && operation.validation.pageCount <= MAX_CUPS_PDF_PAGES
    && JSON.stringify(operation.validation.validators) === JSON.stringify(VALIDATORS);
  if (!valid) invalid(runtime, 'Print-to-PDF provenance does not match the fixed local profile.');
  return operation.validation.pageCount;
}

function validateEvidence(evidence, document, runtime) {
  if (!evidence || !Buffer.isBuffer(evidence.bytes) || evidence.bytes.length !== document.size
    || createHash('sha256').update(evidence.bytes).digest('hex') !== document.sha256) {
    invalid(runtime, 'The retained CUPS PDF bytes are invalid.');
  }
  const { inspection, pages, textPages } = evidence;
  const count = inspection?.pageCount;
  let textBytes = 0;
  const valid = Number.isSafeInteger(count) && count >= 1 && count <= MAX_CUPS_PDF_PAGES
    && inspection.encrypted === 'no' && inspection.javascript === 'no' && inspection.form === 'none'
    && Array.isArray(pages) && pages.length === count && pages.every((page, index) => page?.page === index + 1
      && Number.isFinite(page.widthPoints) && page.widthPoints > 0 && page.widthPoints <= MAX_POINTS
      && Number.isFinite(page.heightPoints) && page.heightPoints > 0 && page.heightPoints <= MAX_POINTS)
    && Array.isArray(textPages) && textPages.length === count && textPages.every((page, index) => {
      if (page?.page !== index + 1 || typeof page?.text !== 'string') return false;
      textBytes += Buffer.byteLength(page.text, 'utf8'); return textBytes <= MAX_TEXT;
    });
  if (!valid) invalid(runtime, 'The retained CUPS PDF evidence failed independent checks.');
  const joined = textPages.map((page) => page.text).join('\n');
  return Object.freeze({
    pageCount: count,
    pages: pages.map(({ page, widthPoints, heightPoints }) => ({ page, widthPoints, heightPoints })),
    nonEmptyPages: textPages.filter((page) => page.text.trim()).length,
    textBytes: Buffer.byteLength(joined),
    textSha256: createHash('sha256').update(joined).digest('hex'),
  });
}

function assertPublishedReceipt(value, bytes, runtime) {
  if (!value || !Object.isFrozen(value) || value.size !== bytes.length
    || value.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    invalid(runtime, 'The published PDF receipt does not match the retained bytes.');
  }
}

async function revoke(application, id, original) {
  try {
    await application.store.deleteDocument(id);
  } catch (error) {
    const cleanup = new Error('Print-to-PDF failed and its derived document could not be revoked.');
    cleanup.code = 'CLI_CONVERSION_CLEANUP_FAILED';
    cleanup.cause = new AggregateError([original, error], 'Conversion cleanup failed.');
    throw cleanup;
  }
  throw original;
}

function receipt(command, source, document, checked) {
  return {
    kind: 'cups-text-to-pdf', output: basename(command.output),
    source: { format: 'txt', size: source.bytes.length, sha256: source.sha256 },
    pdf: { size: document.size, sha256: document.sha256, pages: checked.pageCount },
    pageGeometry: checked.pages,
    text: { pageCount: checked.pageCount, nonEmptyPages: checked.nonEmptyPages, aggregateBytes: checked.textBytes, aggregateSha256: checked.textSha256 },
    passiveIndicators: { encrypted: 'no', javascript: 'no', form: 'none' },
    fidelityExclusions: FIDELITY_EXCLUSIONS, localOnly: true,
  };
}

export async function runPrintToPdfCommand(application, command, stdout, signal, runtime) {
  const { cancelled, canonicalOutputTarget, emit, readLocalInputBytes, writeExclusiveVerified } = runtime;
  if (!application?.cupsPrintToPdf?.convertInput || !application.cupsPrintToPdf?.prepareRetainedArtifactExport) {
    invalid(runtime, 'Print-to-PDF is unavailable.', 'CLI_CUPS_PRINT_TO_PDF_UNAVAILABLE');
  }
  await canonicalOutputTarget(command.output);
  const selected = await readLocalInputBytes(command.input, {
    minimumBytes: 1, maximumBytes: MAX_CUPS_TEXT_INPUT_BYTES, extension: '.txt', signal,
  });
  strictText(selected.bytes, runtime);
  const source = Object.freeze({ ...selected, sha256: createHash('sha256').update(selected.bytes).digest('hex') });
  const asset = await application.inputs.createInput({
    stream: Readable.from([source.bytes]), displayName: source.displayName, mediaType: 'text/plain',
  });
  if (!validAsset(asset, source)) invalid(runtime, 'The private text input record is inconsistent.', 'CLI_INVALID_INPUT_RECORD');
  await application.inputs.verifyInput(asset.id);
  cancelled(signal);
  let id = null;
  try {
    const document = await application.cupsPrintToPdf.convertInput(asset.id, { signal });
    const pages = validateDocument(document, asset, runtime);
    id = document.id;
    cancelled(signal);
    const evidence = await application.cupsPrintToPdf.prepareRetainedArtifactExport(id, { signal });
    const checked = validateEvidence(evidence, document, runtime);
    if (checked.pageCount !== pages) invalid(runtime, 'CUPS PDF page count changed after conversion.');
    await writeExclusiveVerified(command.output, evidence.bytes, signal, async (published) => {
      assertPublishedReceipt(published, evidence.bytes, runtime);
      cancelled(signal);
      await emit(stdout, receipt(command, source, document, checked));
    });
  } catch (error) {
    if (id) await revoke(application, id, error);
    throw error;
  }
}
