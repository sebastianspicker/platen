import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { validateOperationProvenance } from '../../host/operation-provenance.mjs';
import { OPTIMIZE_VALIDATORS } from '../../host/conversion-optimize-export.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PAGES = 200;

const LIMITATIONS = Object.freeze([
  'Ghostscript performs a bounded PDF rewrite; exact byte, visual, font, annotation, form, link, metadata, and signature preservation are not claimed.',
  'The output is accepted only when Poppler reports identical page geometry and extracted text for every page.',
]);

function invalid(runtime, code, message) { runtime.fail(code, message); }

function exactValidators(value) {
  return Array.isArray(value) && value.length === OPTIMIZE_VALIDATORS.length
    && value.every((entry, index) => entry === OPTIMIZE_VALIDATORS[index]);
}

function assertDerivedRecord(document, source, runtime) {
  let operation;
  try { operation = validateOperationProvenance(document?.operation); } catch {
    invalid(runtime, 'CLI_INVALID_OPTIMIZE_PROVENANCE', 'Optimization returned invalid provenance.');
  }
  const input = operation.inputs.length === 1 ? operation.inputs[0] : null;
  const valid = OPAQUE_ID.test(document?.id ?? '')
    && document.origin === 'derived'
    && document.mediaType === 'application/pdf'
    && SHA256.test(document.sha256 ?? '')
    && Number.isSafeInteger(document.size) && document.size >= 64
    && operation.type === 'optimize-pdf'
    && input?.documentId === source.id && input.sha256 === source.sha256 && input.role === 'primary'
    && Object.keys(operation.parameters ?? {}).length === 1 && operation.parameters.mode === 'optimize'
    && operation.validation?.passed === true
    && Number.isSafeInteger(operation.validation.pageCount)
    && operation.validation.pageCount >= 1 && operation.validation.pageCount <= MAX_PAGES
    && exactValidators(operation.validation.validators);
  if (!valid) invalid(runtime, 'CLI_INVALID_OPTIMIZE_PROVENANCE', 'Optimization returned a record outside the fixed provenance contract.');
  return operation;
}

function assertEvidence(evidence, document, source, runtime) {
  const geometryEqual = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((page, index) => page?.page === right[index]?.page
      && page?.widthPoints === right[index]?.widthPoints && page?.heightPoints === right[index]?.heightPoints);
  const textEqual = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((page, index) => page?.page === right[index]?.page
      && page?.text === right[index]?.text);
  const valid = evidence && typeof evidence === 'object'
    && Buffer.isBuffer(evidence.bytes)
    && evidence.bytes.length === document.size
    && createHash('sha256').update(evidence.bytes).digest('hex') === document.sha256
    && evidence.outputDigest === document.sha256
    && evidence.sourceDigest === source.sha256
    && evidence.outputSize === document.size
    && evidence.sourceSize === source.size
    && Number.isSafeInteger(evidence.pageCount) && evidence.pageCount >= 1 && evidence.pageCount <= MAX_PAGES
    && Array.isArray(evidence.pageGeometry) && evidence.pageGeometry.length === evidence.pageCount
    && Array.isArray(evidence.textPages) && evidence.textPages.length === evidence.pageCount
    && geometryEqual(evidence.sourcePageGeometry, evidence.pageGeometry)
    && textEqual(evidence.sourceTextPages, evidence.textPages)
    && SHA256.test(evidence.sourceTextDigest ?? '')
    && evidence.sourceTextDigest === evidence.outputTextDigest
    && Number.isSafeInteger(evidence.textBytes) && evidence.textBytes >= 0
    && evidence.geometryPreserved === true && evidence.textPreserved === true
    && evidence.passiveIndicators?.encrypted === 'no'
    && evidence.passiveIndicators?.javascript === 'no'
    && evidence.passiveIndicators?.form === 'none';
  if (!valid) invalid(runtime, 'CLI_INVALID_OPTIMIZE_EVIDENCE', 'The optimized PDF failed exact retained-byte evidence validation.');
}

function cleanupFailure(original, cleanupError) {
  const error = new Error('Optimization failed and its validated derived document could not be revoked.');
  error.code = 'CLI_OPTIMIZE_CLEANUP_FAILED';
  error.cause = new AggregateError([original, cleanupError], 'Optimization and derived-document cleanup failed.');
  return error;
}

export async function runOptimizeCompressCommand(application, command, source, stdout, signal, runtime) {
  const { cancelled, canonicalOutputTarget, emit, writeExclusiveVerified } = runtime;
  await canonicalOutputTarget(command.output);
  cancelled(signal);
  let validatedDocumentId = null;
  let committed = false;
  try {
    const derived = await application.conversion.rewriteDocument(source.id, 'optimize', { signal });
    const stored = application.store.getDocument(derived?.id);
    if (!stored || stored.id !== derived.id || stored.sha256 !== derived.sha256) {
      invalid(runtime, 'CLI_INVALID_OPTIMIZE_PROVENANCE', 'Optimization returned a document record that is not retained by the local store.');
    }
    assertDerivedRecord(stored, source, runtime);
    validatedDocumentId = stored.id;
    cancelled(signal);
    const evidence = await application.conversion.prepareOptimizePdfExport(stored.id, { signal });
    assertEvidence(evidence, stored, source, runtime);
    cancelled(signal);
    await writeExclusiveVerified(command.output, evidence.bytes, signal, async (receipt) => {
      const receiptValid = receipt && receipt.size === evidence.bytes.length && receipt.sha256 === evidence.outputDigest;
      if (!receiptValid) invalid(runtime, 'CLI_INVALID_OPTIMIZE_RECEIPT', 'The published optimization receipt does not match the validated bytes.');
      cancelled(signal);
      await emit(stdout, {
        kind: 'optimize-compress-local',
        output: basename(command.output),
        source: { sha256: evidence.sourceDigest, size: evidence.sourceSize },
        outputPdf: { sha256: evidence.outputDigest, size: evidence.outputSize },
        savedBytes: evidence.savedBytes,
        reduced: evidence.reduced,
        pageCount: evidence.pageCount,
        pageGeometry: evidence.pageGeometry,
        geometryPreserved: true,
        textPreserved: true,
        text: {
          pageCount: evidence.textPages.length,
          sha256: evidence.outputTextDigest,
          bytes: evidence.textBytes,
          preserved: evidence.textPreserved,
        },
        passiveIndicators: evidence.passiveIndicators,
        validation: { passed: true, validators: OPTIMIZE_VALIDATORS },
        limitations: LIMITATIONS,
        localOnly: true,
      });
      committed = true;
    });
  } catch (error) {
    if (!validatedDocumentId || committed) throw error;
    try {
      let retained = true;
      try { application.store.getDocument(validatedDocumentId); }
      catch (lookupError) {
        if (lookupError?.code === 'DOCUMENT_NOT_FOUND') retained = false;
        else throw lookupError;
      }
      if (retained) await application.store.deleteDocument(validatedDocumentId);
    }
    catch (cleanupError) { throw cleanupFailure(error, cleanupError); }
    throw error;
  }
}
