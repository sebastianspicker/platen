import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { validateOperationProvenance } from '../../host/operation-provenance.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PAGE_POINTS = 14_400;

function invalid(runtime, profile, message, code = profile.invalidCode) {
  runtime.fail(code, message);
}

function exactValidators(value) {
  return Array.isArray(value)
    && value.length === 3
    && value[0] === 'source-sha256'
    && value[1] === 'libreoffice-exit-zero'
    && value[2] === 'pdfinfo-page-count';
}

function assertInputAsset(asset, source, runtime, profile) {
  const valid = [
    Boolean(asset),
    OPAQUE_ID.test(asset?.id ?? ''),
    asset?.displayName === source.displayName,
    asset?.mediaType === profile.mediaType,
    asset?.kind === profile.sourceKind,
    asset?.extension === profile.extension,
    asset?.size === source.bytes.length,
    asset?.sha256 === source.sha256,
  ].every(Boolean);
  if (!valid) invalid(runtime, profile, profile.inputRecordMessage, 'CLI_INVALID_INPUT_RECORD');
}

function validDerivedDocument(document, profile) {
  return [
    OPAQUE_ID.test(document?.id ?? ''),
    document?.origin === 'derived',
    document?.mediaType === 'application/pdf',
    Number.isSafeInteger(document?.size),
    document?.size >= 64,
    document?.size <= profile.maxPdfBytes,
    SHA256.test(document?.sha256 ?? ''),
  ].every(Boolean);
}

function validProvenanceInput(operation, asset) {
  const input = operation.inputs[0];
  return [
    operation.inputs.length === 1,
    input?.assetId === asset.id,
    input?.sha256 === asset.sha256,
    input?.role === 'source',
  ].every(Boolean);
}

function validProvenanceProfile(operation, profile) {
  const parameters = operation.parameters;
  return [
    operation.type === profile.operationType,
    parameters.sourceFormat === profile.sourceFormat,
    parameters.sourceKind === profile.sourceKind,
    parameters.conversionMode === 'libreoffice',
    operation.expected.minimumPageCount === 1,
  ].every(Boolean);
}

function validProvenanceValidation(operation, profile) {
  const { pageCount, validators } = operation.validation;
  return [
    operation.validation.passed === true,
    Number.isSafeInteger(pageCount),
    pageCount >= 1,
    pageCount <= profile.maxPages,
    exactValidators(validators),
  ].every(Boolean);
}

function assertProvenance(document, asset, runtime, profile) {
  let operation;
  try {
    operation = validateOperationProvenance(document?.operation);
  } catch {
    invalid(runtime, profile, profile.invalidProvenanceMessage);
  }
  const pageCount = operation.validation?.pageCount;
  const valid = [
    validDerivedDocument(document, profile),
    validProvenanceInput(operation, asset),
    validProvenanceProfile(operation, profile),
    validProvenanceValidation(operation, profile),
  ].every(Boolean);
  if (!valid) invalid(runtime, profile, profile.provenanceMessage);
  return pageCount;
}

function hasExactEvidenceShape(evidence) {
  const keys = evidence && typeof evidence === 'object' ? Reflect.ownKeys(evidence) : [];
  return [
    evidence && typeof evidence === 'object',
    !Array.isArray(evidence),
    keys.length === 4,
    ['bytes', 'inspection', 'pages', 'textPages'].every((key) => keys.includes(key)),
    Buffer.isBuffer(evidence?.bytes),
  ].every(Boolean);
}

function hasPassiveIndicators(inspection) {
  return [
    String(inspection?.encrypted).toLowerCase() === 'no',
    String(inspection?.javascript).toLowerCase() === 'no',
    String(inspection?.form).toLowerCase() === 'none',
  ].every(Boolean);
}

function validPageGeometry(page, index) {
  return [
    page?.page === index + 1,
    Number.isFinite(page?.widthPoints),
    page?.widthPoints > 0,
    page?.widthPoints <= MAX_PAGE_POINTS,
    Number.isFinite(page?.heightPoints),
    page?.heightPoints > 0,
    page?.heightPoints <= MAX_PAGE_POINTS,
  ].every(Boolean);
}

function hasExactGeometry(pages, pageCount) {
  return Array.isArray(pages)
    && pages.length === pageCount
    && pages.every(validPageGeometry);
}

function hasExactText(textPages, pageCount, profile) {
  if (!Array.isArray(textPages) || textPages.length !== pageCount) return false;
  let textBytes = 0;
  return textPages.every((page, index) => {
    if (page?.page !== index + 1 || typeof page?.text !== 'string') return false;
    textBytes += Buffer.byteLength(page.text, 'utf8') + (index ? 1 : 0);
    return textBytes <= profile.maxTextBytes;
  });
}

function assertEvidence(evidence, document, runtime, profile) {
  if (!hasExactEvidenceShape(evidence)) invalid(runtime, profile, profile.noBytesMessage);
  const { bytes, inspection, pages, textPages } = evidence;
  const pageCount = inspection?.pageCount;
  const valid = [
    Number.isSafeInteger(pageCount),
    pageCount >= 1,
    pageCount <= profile.maxPages,
    bytes.length === document.size,
    createHash('sha256').update(bytes).digest('hex') === document.sha256,
    hasPassiveIndicators(inspection),
    hasExactGeometry(pages, pageCount),
    hasExactText(textPages, pageCount, profile),
  ].every(Boolean);
  if (!valid) invalid(runtime, profile, profile.evidenceMessage);
  const text = textPages.map((page) => page.text).join('\n');
  return Object.freeze({
    pageCount,
    pages: Object.freeze(pages.map(({ page, widthPoints, heightPoints }) => Object.freeze({
      page, widthPoints, heightPoints,
    }))),
    textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    textNonEmptyPages: textPages.filter(({ text: value }) => value.trim().length > 0).length,
    textBytes: Buffer.byteLength(text, 'utf8'),
    indicators: Object.freeze({ encrypted: 'no', javascript: 'no', form: 'none' }),
  });
}

function assertReceipt(receipt, expected, runtime, profile) {
  const keys = receipt && typeof receipt === 'object' ? Reflect.ownKeys(receipt) : [];
  const prototype = receipt && typeof receipt === 'object' ? Object.getPrototypeOf(receipt) : undefined;
  const valid = [
    receipt && typeof receipt === 'object',
    Object.isFrozen(receipt),
    prototype === Object.prototype || prototype === null,
    keys.length === 2,
    keys.includes('size'),
    keys.includes('sha256'),
    Number.isSafeInteger(receipt?.size),
    receipt?.size === expected.size,
    receipt?.sha256 === expected.sha256,
  ].every(Boolean);
  if (!valid) invalid(runtime, profile, profile.receiptMessage);
}

function cleanupFailure(original, cleanupError, profile) {
  const error = new Error(profile.cleanupMessage);
  error.code = 'CLI_CONVERSION_CLEANUP_FAILED';
  error.cause = new AggregateError([original, cleanupError], profile.cleanupAggregateMessage);
  return error;
}

function emitReceipt({ stdout, emit, source, evidence, pdfSha256, checked, profile }) {
  return emit(stdout, {
    kind: profile.operationType,
    source: { format: profile.sourceFormat, size: source.bytes.length, sha256: source.sha256 },
    pdf: { size: evidence.bytes.length, sha256: pdfSha256, pages: checked.pageCount },
    pageGeometry: checked.pages,
    text: {
      pageCount: checked.pageCount,
      nonEmptyPages: checked.textNonEmptyPages,
      aggregateBytes: checked.textBytes,
      aggregateSha256: checked.textSha256,
    },
    passiveIndicators: checked.indicators,
    fidelityExclusions: profile.fidelityExclusions,
    localOnly: true,
  });
}

function publicationFinalizer(context) {
  return async (receipt) => {
    assertReceipt(receipt, {
      size: context.evidence.bytes.length,
      sha256: context.pdfSha256,
    }, context.runtime, context.profile);
    context.runtime.cancelled(context.signal);
    await emitReceipt(context);
  };
}

async function revokeFailedDocument(application, documentId, original, profile) {
  try {
    await application.store.deleteDocument(documentId);
  } catch (cleanupError) {
    throw cleanupFailure(original, cleanupError, profile);
  }
  throw original;
}

export async function runLibreOfficeConversionCommand(
  application, command, stdout, signal, runtime, profile,
) {
  const { cancelled, canonicalOutputTarget, emit, readLocalInputBytes, writeExclusiveVerified } = runtime;
  await canonicalOutputTarget(command.output);
  const selected = await readLocalInputBytes(command.input, {
    minimumBytes: profile.minimumInputBytes,
    maximumBytes: profile.maxInputBytes,
    extension: profile.extension,
    signal,
  });
  if (profile.assertInput) {
    try {
      profile.assertInput(selected.bytes);
    } catch (error) {
      invalid(runtime, profile, error.message, error.code ?? 'CLI_INVALID_INPUT');
    }
  }
  cancelled(signal);
  const source = Object.freeze({
    ...selected,
    sha256: createHash('sha256').update(selected.bytes).digest('hex'),
  });
  const asset = await application.inputs.createInput({
    stream: Readable.from([source.bytes]), displayName: source.displayName, mediaType: profile.mediaType,
  });
  assertInputAsset(asset, source, runtime, profile);
  await application.inputs.verifyInput(asset.id);
  cancelled(signal);
  let validatedDocumentId = null;
  try {
    const document = await application.conversion.convertInput(asset.id, { signal });
    const provenancePages = assertProvenance(document, asset, runtime, profile);
    validatedDocumentId = document.id;
    cancelled(signal);
    const evidence = await application.conversion[profile.exportMethod](document.id, { signal });
    const checked = assertEvidence(evidence, document, runtime, profile);
    if (checked.pageCount !== provenancePages) invalid(runtime, profile, profile.pageCountMessage);
    const pdfSha256 = createHash('sha256').update(evidence.bytes).digest('hex');
    const finalize = publicationFinalizer({
      stdout, emit, source, evidence, pdfSha256, checked, profile, runtime, signal,
    });
    await writeExclusiveVerified(command.output, evidence.bytes, signal, finalize);
  } catch (error) {
    if (!validatedDocumentId) throw error;
    await revokeFailedDocument(application, validatedDocumentId, error, profile);
  }
}
