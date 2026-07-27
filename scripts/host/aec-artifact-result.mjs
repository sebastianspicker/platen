import { createOperationProvenance } from './operation-provenance.mjs';
import { deepFreeze } from './aec-artifact-validation.mjs';
import { AEC_MEASURE_DICTIONARY_PROFILE } from './pdf-aec-measure-writer.mjs';

export const AEC_MATERIALIZATION_RECEIPT_SCHEMA = 'platen-aec-materialization-receipt-v2';
export const AEC_COUNT_ANNOTATION_PROFILE = 'platen-aec-count-annotation-v1';

const BASE_VALIDATORS = Object.freeze([
  'source-sha256',
  'workspace-revision',
  'cropbox-geometry-sha256',
  'pinned-helper-sha256',
  'pdfkit-effect-reopen',
  'poppler-page-count',
  'poppler-render-all-pages',
]);

const MEASURE_DICTIONARY_VALIDATORS = Object.freeze([
  'classic-xref-measure-dictionary',
  'measure-dictionary-raw-reinspection',
  'source-prefix-preserved',
]);

export function createAecMaterializationReceipt(nativeReceipt, embedding) {
  const embedded = embedding.proof !== null;
  return deepFreeze({
    schema: AEC_MATERIALIZATION_RECEIPT_SCHEMA,
    version: 2,
    operation: nativeReceipt.operation,
    profile: embedded ? AEC_MEASURE_DICTIONARY_PROFILE : AEC_COUNT_ANNOTATION_PROFILE,
    sourceSha256: embedding.nativeOutputSha256,
    outputSha256: embedding.outputSha256,
    measurementId: nativeReceipt.measurementId,
    page: nativeReceipt.page,
    kind: nativeReceipt.kind,
    quantity: nativeReceipt.quantity,
    unit: nativeReceipt.unit,
    calibrationId: nativeReceipt.calibrationId,
    annotationCount: nativeReceipt.annotationCount,
    annotationSubtypes: nativeReceipt.annotationSubtypes,
    measurementDictionaryEmbedded: embedded,
    measurementDictionaryScope: embedding.proof?.measurementDictionaryScope ?? null,
    sourcePrefixPreserved: true,
    rootPreserved: embedding.proof?.rootPreserved ?? true,
    infoPreserved: embedding.proof?.infoPreserved ?? true,
    catalogVersionRaised: embedding.proof?.catalogVersionRaised ?? false,
    idPolicy: embedding.proof?.idPolicy ?? 'unchanged-native-output',
    pageCount: nativeReceipt.pageCount,
  });
}

export function createAecMaterializationProvenance({ documentId, document, measurement, receipt }) {
  const validators = receipt.measurementDictionaryEmbedded
    ? [...BASE_VALIDATORS, ...MEASURE_DICTIONARY_VALIDATORS]
    : [...BASE_VALIDATORS, 'count-measure-dictionary-not-applicable'];
  return createOperationProvenance({
    type: 'pdfkit-aec-measurement',
    inputs: [{ documentId, sha256: document.sha256, role: 'source' }],
    parameters: {
      measurementId: measurement.id,
      measurementProvenanceSha256: measurement.provenanceSha256,
      page: measurement.source.page,
      kind: measurement.kind,
      measurementDictionaryProfile: receipt.measurementDictionaryEmbedded ? receipt.profile : null,
      measurementDictionaryScope: receipt.measurementDictionaryScope,
    },
    expected: {
      pageCount: receipt.pageCount,
      rasterized: false,
      nativeAnnotations: receipt.annotationCount,
      measurementDictionaryEmbedded: receipt.measurementDictionaryEmbedded,
    },
    validation: {
      passed: true,
      validators,
      nativeOutputSha256: receipt.sourceSha256,
      outputSha256: receipt.outputSha256,
      pageCount: receipt.pageCount,
      annotationCount: receipt.annotationCount,
    },
  });
}

function limitations(receipt) {
  const measureLimitation = receipt.measurementDictionaryEmbedded
    ? 'Calibrated scale is attached to the page viewport; only a two-point line also carries line-level /Measure and /IT /LineDimension keys, while PDFKit Ink perimeter and area markups rely on that viewport.'
    : 'Count annotations are intentionally uncalibrated because PDF /Measure dictionaries describe geometric scale, not count semantics.';
  return Object.freeze([
    measureLimitation,
    'The source PDF remains unchanged; PDFKit may rewrite unsupported object structure in the separate artifact before the append-only calibrated revision.',
    'Review annotation appearance and measurement accuracy before professional use.',
  ]);
}

export function createAecMaterializationResult({
  document,
  measurement,
  artifact,
  nativeReceipt,
  receipt,
}) {
  return deepFreeze({
    kind: 'pdf-native-aec-measurement',
    schemaVersion: 2,
    sourceDigest: document.sha256,
    measurement,
    artifact,
    nativeReceipt,
    receipt,
    evidence: {
      localOnly: true,
      sourceBound: true,
      nativeAnnotations: true,
      helperReopened: true,
      popplerParsed: true,
      allPagesRendered: true,
      sourceUnchanged: true,
    },
    limitations: limitations(receipt),
  });
}
