import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { validateOperationProvenance } from '../../host/operation-provenance.mjs';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXCLUSIONS = Object.freeze([
  'Only the minimal DXF LINE subset is supported.',
  'Coordinates are unitless PDF-space values, rounded to six decimal places, drawn as fixed black one-point strokes, and clipped by the fixed 612 by 792 point page.',
  'DWG, BIM, IFC, Revit, general CAD/DXF semantics, layers, blocks, arcs, polylines, text, hatches, units, colors, lineweights, fonts, metadata, viewports, layouts, multipage output, and exact visual fidelity are excluded.',
]);

function invalid(runtime, message, code = 'CLI_INVALID_CAD_TO_PDF') { runtime.fail(code, message); }

function validators(value) {
  return Array.isArray(value) && value.length === 3 && value[0] === 'source-sha256'
    && value[1] === 'platen-dxf-line-subset-renderer' && value[2] === 'pdfinfo-page-count';
}

function assertInput(asset, source, runtime) {
  if (!asset || !OPAQUE_ID.test(asset.id ?? '') || asset.displayName !== source.displayName
    || asset.mediaType !== 'image/vnd.dxf' || asset.kind !== 'cad' || asset.extension !== '.dxf'
    || asset.size !== source.bytes.length || asset.sha256 !== source.sha256) {
    invalid(runtime, 'The private DXF input record is inconsistent.', 'CLI_INVALID_INPUT_RECORD');
  }
}

function assertDocument(document, asset, runtime) {
  let operation;
  try { operation = validateOperationProvenance(document?.operation); } catch { invalid(runtime, 'CAD conversion returned invalid operation provenance.'); }
  const input = operation.inputs[0]; const params = operation.parameters;
  const valid = OPAQUE_ID.test(document?.id ?? '') && document.origin === 'derived'
    && document.mediaType === 'application/pdf' && Number.isSafeInteger(document.size)
    && document.size >= 5 && document.size <= MAX_PDF_BYTES && SHA256.test(document.sha256 ?? '')
    && operation.type === 'cad-to-pdf' && operation.inputs.length === 1 && input?.assetId === asset.id
    && input.sha256 === asset.sha256 && input.role === 'source' && params.sourceFormat === 'dxf'
    && params.sourceKind === 'cad' && params.conversionMode === 'platen-dxf-line-subset'
    && Number.isSafeInteger(params.entityCount) && params.entityCount >= 1 && params.entityCount <= 2_000
    && params.widthPoints === 612 && params.heightPoints === 792 && operation.expected?.pageCount === 1
    && Object.keys(params).length === 6 && Object.keys(operation.expected ?? {}).length === 1
    && Object.keys(operation.validation ?? {}).length === 3 && Object.keys(input ?? {}).length === 3
    && operation.validation?.passed === true && operation.validation.pageCount === 1 && validators(operation.validation.validators);
  if (!valid) invalid(runtime, 'CAD conversion provenance does not match the fixed local DXF profile.');
  return params.entityCount;
}

function assertEvidence(evidence, document, entityCount, runtime) {
  const keys = evidence && typeof evidence === 'object' ? Reflect.ownKeys(evidence) : [];
  const geometry = evidence?.pageGeometry;
  const passive = evidence?.passiveIndicators;
  const inspection = evidence?.inspection;
  const valid = Object.isFrozen(evidence) && keys.length === 5
    && ['bytes', 'inspection', 'pageGeometry', 'entityCount', 'passiveIndicators'].every((key) => keys.includes(key))
    && Buffer.isBuffer(evidence.bytes) && evidence.bytes.length === document.size
    && createHash('sha256').update(evidence.bytes).digest('hex') === document.sha256
    && inspection?.pageCount === 1 && inspection.encrypted === 'no' && inspection.javascript === 'no' && inspection.form === 'none'
    && geometry?.page === 1 && geometry.widthPoints === 612 && geometry.heightPoints === 792
    && evidence.entityCount === entityCount && passive?.encrypted === 'no' && passive.javascript === 'no' && passive.form === 'none'
    && Object.isFrozen(inspection) && Object.isFrozen(geometry) && Object.isFrozen(passive)
    && Reflect.ownKeys(inspection).length === 4 && Reflect.ownKeys(geometry).length === 3 && Reflect.ownKeys(passive).length === 3;
  if (!valid) invalid(runtime, 'The CAD PDF export failed the fixed independent checks.');
  return Object.freeze({ pageGeometry: Object.freeze({ ...geometry }), passiveIndicators: Object.freeze({ ...passive }) });
}

function cleanupFailure(original, cleanupError) {
  const error = new Error('CAD conversion failed and its private derived document could not be revoked.');
  error.code = 'CLI_CONVERSION_CLEANUP_FAILED';
  error.cause = new AggregateError([original, cleanupError], 'CAD conversion and derived document cleanup failed.');
  return error;
}

function assertReceipt(receipt, size, sha256, runtime) {
  if (!receipt || !Object.isFrozen(receipt) || Reflect.ownKeys(receipt).length !== 2
    || receipt.size !== size || receipt.sha256 !== sha256) {
    invalid(runtime, 'The published PDF receipt does not match the validated derived bytes.');
  }
}

export async function runCadToPdfCommand(application, command, stdout, signal, runtime) {
  const { cancelled, canonicalOutputTarget, emit, readLocalInputBytes, writeExclusiveVerified } = runtime;
  if (extname(command.input).toLowerCase() !== '.dxf' || extname(command.output).toLowerCase() !== '.pdf') {
    invalid(runtime, 'The selected input must be .dxf and output must be .pdf.');
  }
  await canonicalOutputTarget(command.output);
  const selected = await readLocalInputBytes(command.input, { minimumBytes: 5, maximumBytes: MAX_SOURCE_BYTES, signal });
  cancelled(signal);
  const source = Object.freeze({ ...selected, sha256: createHash('sha256').update(selected.bytes).digest('hex') });
  const asset = await application.inputs.createInput({ stream: Readable.from([source.bytes]), displayName: source.displayName, mediaType: 'image/vnd.dxf' });
  assertInput(asset, source, runtime); await application.inputs.verifyInput(asset.id); cancelled(signal);
  let documentId = null;
  try {
    const document = await application.conversion.convertCadInput(asset.id, { signal });
    const entityCount = assertDocument(document, asset, runtime); documentId = document.id; cancelled(signal);
    const evidence = await application.conversion.prepareCadPdfExport(document.id, { signal });
    const checked = assertEvidence(evidence, document, entityCount, runtime);
    const sha256 = createHash('sha256').update(evidence.bytes).digest('hex');
    await writeExclusiveVerified(command.output, evidence.bytes, signal, async (receipt) => {
      assertReceipt(receipt, evidence.bytes.length, sha256, runtime); cancelled(signal);
      await emit(stdout, { kind: 'cad-to-pdf', output: basename(command.output), source: { format: 'dxf', size: source.bytes.length, sha256: source.sha256 },
        pdf: { size: evidence.bytes.length, sha256, pages: 1 }, pageGeometry: checked.pageGeometry, entityCount,
        passiveIndicators: checked.passiveIndicators, fidelityExclusions: EXCLUSIONS, localOnly: true });
    });
  } catch (error) {
    if (!documentId) throw error;
    try { await application.store.deleteDocument(documentId); } catch (cleanupError) { throw cleanupFailure(error, cleanupError); }
    throw error;
  }
}
