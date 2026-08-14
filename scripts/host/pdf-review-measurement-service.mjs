import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createAecFinalOutput } from './aec-measure-embedding.mjs';
import {
  MAX_OUTPUT_BYTES,
  MAX_PAGES,
  MAX_SOURCE_BYTES,
  TIMEOUT_MS,
  assertWorkspace,
  createJobSignal,
  preparePrivateExport,
  validateHelperExport,
} from './aec-artifact-export.mjs';
import { renderAllPages } from './aec-artifact-render.mjs';
import {
  UNIT_METERS,
  assertGeometry,
  assertInsideBox,
  canonical,
  deepFreeze,
  distance,
  displayValue,
  hash,
  quantity,
  sourceBinding,
} from './aec-artifact-validation.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { pdfReference } from './pdf-classic-syntax.mjs';
import { executeOfflineSignatureInspection, parsePdfInfo } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import {
  PDF_REVIEW_MEASUREMENT_PROFILE,
  REVIEW_MEASUREMENT_LIMITS,
  normalizePdfReviewMeasurement,
  validatePdfReviewMeasurementResult,
} from './pdf-review-measurement-contract.mjs';

const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const UNSAFE_KEYS = new Set(['A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'Launch', 'SubmitForm', 'GoToR', 'GoToE', 'URI', 'AcroForm', 'XFA', 'Perms', 'StructTreeRoot', 'OCProperties', 'OC', 'Measure', 'VP', 'Metadata', 'EmbeddedFiles', 'Names', 'Outlines', 'ByteRange', 'Sig', 'Widget', 'FileAttachment', 'Sound', 'RichMedia', '3D', 'FT']);
const OUTPUT_ALLOWED_KEYS = new Set(['A', 'Measure', 'VP', 'IT', 'Metadata']);

function host(code, message, status = 502, cause = undefined) {
  return new HostError(code, message, status, cause === undefined ? undefined : { cause });
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function inspectDictionary(value, structure, seen, { output = false, resolveRefs = true } = {}) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'ref') {
    const key = `${value.object}:${value.generation}`;
    if (!resolveRefs || seen.has(key)) return;
    seen.add(key);
    try { inspectDictionary(resolvePdfObject(structure, value).value, structure, seen, { output, resolveRefs }); } catch { throw host('PDF_REVIEW_MEASUREMENT_SOURCE_UNSUPPORTED', 'The PDF contains an unresolvable indirect object.', 422); }
    return;
  }
  if (value.type === 'array') { value.values.forEach((entry) => inspectDictionary(entry, structure, seen, { output, resolveRefs })); return; }
  if (value.type !== 'dict') return;
  const dictionaryType = value.entries.get('Type')?.value;
  for (const [key, child] of value.entries) {
    const outputKeyAllowed = output && OUTPUT_ALLOWED_KEYS.has(key)
      && (key !== 'A' || dictionaryType === 'Measure');
    if ((!outputKeyAllowed) && UNSAFE_KEYS.has(key)) {
      throw host('PDF_REVIEW_MEASUREMENT_SOURCE_UNSUPPORTED', `The PDF contains an unsupported active or measurement context (${key}).`, 422);
    }
    if (key === 'MarkInfo' && child?.type === 'dict' && child.entries.get('Marked')?.value === true) {
      throw host('PDF_REVIEW_MEASUREMENT_SOURCE_UNSUPPORTED', 'Tagged PDFs are outside the passive review-measurement subset.', 422);
    }
    inspectDictionary(child, structure, seen, { output, resolveRefs });
  }
}

function inspectPassiveStructure(bytes, { output = false } = {}) {
  let structure;
  try { structure = parsePdfStructure(bytes); } catch (error) { throw host('PDF_REVIEW_MEASUREMENT_SOURCE_UNSUPPORTED', 'The PDF is outside the bounded passive review-measurement structure.', 422, error); }
  const seen = new Set();
  for (const entry of structure.effective.values()) {
    if (entry.status !== 'n' && entry.status !== 'c') continue;
    try { inspectDictionary(resolvePdfObject(structure, pdfReference({ type: 'ref', object: entry.object, generation: entry.generation })).value, structure, seen, { output, resolveRefs: false }); } catch (error) { if (error instanceof HostError) throw error; throw host('PDF_REVIEW_MEASUREMENT_SOURCE_UNSUPPORTED', 'The PDF contains an unsupported passive-content structure.', 422, error); }
  }
  return structure;
}

function sourceInspectionAllowed(info) {
  return Number.isSafeInteger(info.pageCount) && info.pageCount >= 1 && info.pageCount <= MAX_PAGES
    && String(info.encrypted).toLowerCase() === 'no' && String(info.form).toLowerCase() === 'none'
    && String(info.javascript).toLowerCase() === 'no' && String(info.tagged ?? 'no').toLowerCase() === 'no';
}

function outputInspectionAllowed(info, expectedPageCount) {
  return sourceInspectionAllowed(info) && info.pageCount === expectedPageCount;
}

function buildMeasurement(input, binding) {
  assertInsideBox(input.points, binding.box);
  assertInsideBox(input.calibration.points, binding.box);
  assertGeometry(input.kind, input.points);
  const calibrationDistance = distance(input.calibration.points[0], input.calibration.points[1]);
  const metersPerPdfPoint = input.calibration.realLength * UNIT_METERS[input.calibration.unit] / calibrationDistance;
  if (!Number.isFinite(metersPerPdfPoint) || metersPerPdfPoint <= 0) throw host('PDF_REVIEW_MEASUREMENT_INVALID', 'The requested scale is not finite and positive.', 400);
  const siValue = quantity(input.kind, input.points, metersPerPdfPoint);
  if (!Number.isFinite(siValue) || siValue <= 0) throw host('PDF_REVIEW_MEASUREMENT_INVALID', 'The requested geometry has no positive measurable quantity.', 400);
  const calibration = {
    schemaVersion: 2,
    id: input.calibration.id,
    type: 'scale-calibration',
    source: binding,
    segment: input.calibration.points,
    knownLength: { value: input.calibration.realLength, unit: input.calibration.unit },
    metersPerPdfPoint,
    label: `${input.label} scale`,
    createdAt: new Date(0).toISOString(),
  };
  const base = {
    schemaVersion: 2,
    id: input.id,
    type: 'measurement',
    source: binding,
    calibrationId: calibration.id,
    calibration,
    kind: input.kind,
    geometry: { space: 'pdf-user-space-v1', points: input.points },
    result: {
      dimension: input.kind === 'area' ? 'area' : 'length',
      siValue,
      siUnit: input.kind === 'area' ? 'm2' : 'm',
      displayValue: displayValue(siValue, input.displayUnit),
      displayUnit: input.displayUnit,
    },
    label: input.label,
  };
  return Object.freeze({
    measurement: Object.freeze({ ...base, provenanceSha256: hash(canonical(base)), createdAt: new Date(0).toISOString() }),
    calibration: Object.freeze(calibration),
  });
}

function receipt(document, measurement, nativeReceipt, embedding) {
  return Object.freeze({
    schema: 'platen-review-measurement-receipt-v1',
    version: 1,
    profile: PDF_REVIEW_MEASUREMENT_PROFILE,
    operation: 'applyReviewMeasurement',
    sourceSha256: document.sha256,
    nativeOutputSha256: embedding.nativeOutputSha256,
    outputSha256: embedding.outputSha256,
    measurementId: measurement.id,
    page: measurement.source.page,
    kind: measurement.kind,
    quantity: measurement.result.siValue,
    unit: measurement.result.siUnit,
    calibrationId: measurement.calibrationId,
    annotationCount: nativeReceipt.annotationCount,
    annotationSubtypes: nativeReceipt.annotationSubtypes,
    measurementDictionaryEmbedded: embedding.proof !== null,
    measurementDictionaryScope: embedding.proof?.measurementDictionaryScope ?? null,
    sourcePrefixPreserved: true,
    pageCount: nativeReceipt.pageCount,
  });
}

function limitations(resultReceipt) {
  return Object.freeze([
    'Only one calibrated distance, perimeter, or area annotation on one passive page is admitted; count, volume, angle, and radius are not supported.',
    'The scale is expressed in PDF user space and attached to a bounded page viewport; line dimensions additionally carry a line-level Measure dictionary.',
    'The source PDF remains unchanged. The separately derived PDF is inert and must receive human review before professional delivery.',
    resultReceipt.sourcePrefixPreserved ? 'Historical source bytes remain recoverable in the native intermediate or append-only calibrated revision.' : 'Source-prefix preservation was not established.',
  ]);
}

export class PdfReviewMeasurementService {
  #store; #pdf; #poppler; #pdfkit; #workspaceState; #revisionProvider; #clock;
  constructor({ store, pdfService, poppler, pdfkit = null, workspaceState = null, revisionProvider = null, clock = () => new Date().toISOString() } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfReviewMeasurementService requires a DocumentStore-compatible store.');
    if (!pdfService || typeof pdfService.inspectStructure !== 'function') throw new TypeError('PdfReviewMeasurementService requires PdfService.');
    if (!poppler || typeof poppler.execute !== 'function') throw new TypeError('PdfReviewMeasurementService requires a Poppler adapter.');
    if (pdfkit !== null && typeof pdfkit.applyAecMeasurement !== 'function') throw new TypeError('pdfkit must support applyAecMeasurement or be null.');
    if (workspaceState !== null && typeof workspaceState.snapshot !== 'function') throw new TypeError('workspaceState must provide snapshot(documentId).');
    if (revisionProvider !== null && typeof revisionProvider !== 'function') throw new TypeError('revisionProvider must be a function.');
    if (workspaceState === null && revisionProvider === null) throw new TypeError('PdfReviewMeasurementService requires an authoritative workspaceState or revisionProvider.');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    this.#store = store; this.#pdf = pdfService; this.#poppler = poppler; this.#pdfkit = pdfkit; this.#workspaceState = workspaceState; this.#revisionProvider = revisionProvider; this.#clock = clock;
  }

  get nativeAvailable() { return Boolean(this.#pdfkit); }

  async create(documentId, value, { sourceSha256, signal } = {}) {
    let input;
    try { input = normalizePdfReviewMeasurement(value); } catch (error) { throw host('PDF_REVIEW_MEASUREMENT_OPTIONS_INVALID', 'Review-measurement options are invalid.', 400, error); }
    if (!this.#pdfkit) throw host('PDF_REVIEW_MEASUREMENT_UNAVAILABLE', 'Pinned local PDFKit measurement publication is unavailable.', 503);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const document = this.#store.getDocument(documentId);
    if (sourceSha256 !== undefined && sourceSha256 !== input.sourceSha256) throw host('SOURCE_VERSION_MISMATCH', 'The review-measurement source digest does not match the request.', 409);
    if (document.sha256 !== input.sourceSha256) throw host('SOURCE_VERSION_MISMATCH', 'The review-measurement source digest does not match the current document.', 409);
    if (document.size < 5 || document.size > REVIEW_MEASUREMENT_LIMITS.maxSourceBytes) throw host('PDF_REVIEW_MEASUREMENT_INPUT_TOO_LARGE', 'Review measurement is limited to bounded local PDF sources.', 413);
    let revision;
    if (this.#workspaceState) revision = this.#workspaceState.snapshot(documentId).revision;
    if (this.#revisionProvider) revision = await this.#revisionProvider(documentId);
    if (!Number.isSafeInteger(revision) || revision !== input.expectedRevision) throw host('REVISION_CONFLICT', 'The review-measurement source revision is stale.', 409);
    await this.#store.verifySource(documentId);
    const evidence = await this.#pdf.inspectStructure(documentId, { firstPage: input.page, lastPage: input.page, signal });
    if (!Array.isArray(evidence.pageBoxes) || evidence.pageBoxes.length !== 1 || evidence.pageBoxes[0]?.page !== input.page || !evidence.pageBoxes[0]?.boxes?.cropBox) throw host('PDF_REVIEW_MEASUREMENT_PAGE_UNSUPPORTED', 'Exact source page geometry was not available.', 422);
    const binding = sourceBinding(document, evidence.pageBoxes[0]);
    const derived = buildMeasurement(input, binding);
    const job = createJobSignal(signal); let workspace = null; let promotedArtifact = null; let sourceBytes = null; let outputBytes = null; let completed = false; let failure = null;
    try {
      const sourcePath = this.#store.getSourcePath(documentId);
      sourceBytes = await readFile(sourcePath);
      if (sha256(sourceBytes) !== document.sha256) throw host('SOURCE_INTEGRITY_FAILED', 'The review-measurement source changed before publication.', 500);
      inspectPassiveStructure(sourceBytes);
      const sourceInspection = parsePdfInfo((await this.#poppler.execute('inspect', { input: sourcePath }, { signal: job.signal, timeoutMs: TIMEOUT_MS, maxStdoutBytes: 512 * 1024, maxStderrBytes: 128 * 1024 })).stdout);
      if (!sourceInspectionAllowed(sourceInspection)) throw host('PDF_REVIEW_MEASUREMENT_SOURCE_UNSUPPORTED', 'Review measurements require an unsigned, unencrypted, form-free, JavaScript-free, untagged passive PDF.', 422);
      workspace = await this.#store.createJobWorkspace(documentId);
      let signatures;
      try { signatures = await executeOfflineSignatureInspection(this.#poppler, { input: sourcePath, nssDirectory: workspace, signal: job.signal, timeoutMs: TIMEOUT_MS }); } catch (error) { if (job.signal.aborted) throw error; throw host('PDF_REVIEW_MEASUREMENT_SOURCE_UNSUPPORTED', 'Signature inspection was indeterminate.', 422, error); }
      if (signatures.status !== 'unsigned' || signatures.signatureCount !== 0) throw host('PDF_REVIEW_MEASUREMENT_SOURCE_UNSUPPORTED', 'Signed PDFs are outside the passive review-measurement subset.', 422);
      if (job.signal.aborted) throw job.signal.reason ?? new Error('Review measurement was cancelled.');
      const prepared = await preparePrivateExport({ store: this.#store, documentId, document, workspace, measurement: derived.measurement, calibration: derived.calibration });
      await assertWorkspace(workspace, ['input.pdf', 'request.json']);
      if (job.signal.aborted) throw job.signal.reason ?? new Error('Review measurement was cancelled.');
      const nativeReceipt = await this.#pdfkit.applyAecMeasurement({ workspacePath: workspace, requestPath: prepared.requestPath }, { signal: job.signal, timeoutMs: TIMEOUT_MS });
      const nativeOutputSha256 = await validateHelperExport({ workspace, ...prepared, document, receipt: nativeReceipt, measurement: derived.measurement, pageCount: sourceInspection.pageCount });
      const finalOutputPath = join(workspace, 'final-output.pdf');
      const embedding = await createAecFinalOutput({ nativeOutputPath: prepared.outputPath, finalOutputPath, nativeOutputSha256, measurement: derived.measurement, calibration: derived.calibration, maximumSourceBytes: MAX_SOURCE_BYTES, maximumOutputBytes: MAX_OUTPUT_BYTES, signal: job.signal });
      const outputInspection = parsePdfInfo((await this.#poppler.execute('inspect', { input: finalOutputPath }, { cwd: workspace, signal: job.signal, timeoutMs: TIMEOUT_MS, maxStdoutBytes: 512 * 1024, maxStderrBytes: 128 * 1024 })).stdout);
      if (!outputInspectionAllowed(outputInspection, sourceInspection.pageCount)) throw host('PDF_REVIEW_MEASUREMENT_OUTPUT_INVALID', 'The derived review-measurement PDF changed passive safety state or page count.', 502);
      outputBytes = await readFile(finalOutputPath);
      inspectPassiveStructure(outputBytes, { output: true });
      await renderAllPages({ poppler: this.#poppler, workspace, outputPath: finalOutputPath, pageCount: outputInspection.pageCount, signal: job.signal, workspaceFiles: ['final-output.pdf'] });
      if (sha256(outputBytes) !== embedding.outputSha256) throw host('PDF_REVIEW_MEASUREMENT_OUTPUT_INVALID', 'The derived review-measurement output changed during validation.', 502);
      await this.#store.verifySource(documentId);
      const checkedReceipt = receipt(document, derived.measurement, nativeReceipt, embedding);
      const provenance = createOperationProvenance({
        type: 'pdf-review-measurement',
        inputs: [{ documentId, sha256: document.sha256, role: 'source' }],
        parameters: { measurementId: derived.measurement.id, page: derived.measurement.source.page, kind: derived.measurement.kind, calibrationId: derived.measurement.calibrationId, profile: PDF_REVIEW_MEASUREMENT_PROFILE },
        expected: { pageCount: checkedReceipt.pageCount, rasterized: false, nativeAnnotations: checkedReceipt.annotationCount, measurementDictionaryEmbedded: checkedReceipt.measurementDictionaryEmbedded },
        validation: { passed: true, validators: ['source-sha256', 'source-revision', 'passive-structure', 'signature-free', 'cropbox-geometry', 'pdfkit-effect-reopen', 'measure-dictionary-reinspection', 'poppler-page-count', 'poppler-render-all-pages'], sourceSha256: document.sha256, outputSha256: checkedReceipt.outputSha256, pageCount: checkedReceipt.pageCount, annotationCount: checkedReceipt.annotationCount },
        completedAt: this.#clock(),
      });
      const stem = basename(document.displayName ?? 'document.pdf', extname(document.displayName ?? '.pdf'));
      promotedArtifact = await this.#store.promotePdfArtifact(documentId, finalOutputPath, { displayName: `${stem}-review-measurement.pdf`, operation: provenance, expectedSha256: checkedReceipt.outputSha256, signal: job.signal });
      if (!promotedArtifact || promotedArtifact.documentId !== document.id || promotedArtifact.mediaType !== 'application/pdf' || promotedArtifact.sha256 !== checkedReceipt.outputSha256 || promotedArtifact.size !== outputBytes.length) throw host('PDF_REVIEW_MEASUREMENT_OUTPUT_INVALID', 'The promoted review-measurement artifact is not bound to the validated output.', 502);
      if (job.signal.aborted) throw job.signal.reason ?? new Error('Review measurement was cancelled after promotion.');
      const result = { kind: 'pdf-review-measurement', schemaVersion: 1, sourceDigest: document.sha256, revision, measurement: derived.measurement, artifact: promotedArtifact, receipt: checkedReceipt, evidence: { localOnly: true, sourceBound: true, nativeAnnotations: true, helperReopened: true, popplerParsed: true, allPagesRendered: true, sourceUnchanged: true }, limitations: limitations(checkedReceipt) };
      const validated = validatePdfReviewMeasurementResult(result);
      completed = true;
      return validated;
    } catch (error) {
      if (job.timedOut) failure = host('PDF_REVIEW_MEASUREMENT_TIMEOUT', 'Review measurement exceeded its two-minute deadline.', 504, error);
      else if (signal?.aborted) failure = host('JOB_CANCELLED', 'Review measurement was cancelled.', 499, error);
      else if (error instanceof HostError) failure = error;
      else if (error?.code === 'UNSUPPORTED_AEC_MEASURE_DICTIONARY_PDF' || error?.code === 'AEC_MEASURE_DICTIONARY_UNSUPPORTED') failure = host('PDF_REVIEW_MEASUREMENT_SOURCE_UNSUPPORTED', 'The derived PDF is outside the bounded measurement-dictionary subset.', 422, error);
      else failure = host('PDF_REVIEW_MEASUREMENT_FAILED', 'The local host could not create a validated review-measurement artifact.', 502, error);
      throw failure;
    } finally {
      job.dispose();
      const cleanupErrors = [];
      if (workspace) { try { await this.#store.cleanupJob(workspace); } catch (error) { cleanupErrors.push(error); } }
      if ((!completed || cleanupErrors.length > 0) && promotedArtifact?.id && typeof this.#store.deleteArtifact === 'function') {
        try { await this.#store.deleteArtifact(promotedArtifact.id); } catch (error) { cleanupErrors.push(error); }
      }
      sourceBytes?.fill(0); outputBytes?.fill(0);
      if (cleanupErrors.length) {
        const errors = failure ? [failure, ...cleanupErrors] : cleanupErrors;
        if (errors.length > 1) throw new AggregateError(errors, 'Review-measurement cleanup and revocation failed.');
        throw host('PDF_REVIEW_MEASUREMENT_CLEANUP_FAILED', 'Review-measurement private workspace cleanup failed after publication or revocation.', 500, errors[0]);
      }
    }
  }

  measure(...args) { return this.create(...args); }
  apply(...args) { return this.create(...args); }
}

export function createPdfReviewMeasurementService(options) { return new PdfReviewMeasurementService(options); }
export const createReviewMeasurementService = createPdfReviewMeasurementService;

export function calculatePdfReviewMeasurement(value, binding) {
  const input = normalizePdfReviewMeasurement(value);
  return deepFreeze(buildMeasurement(input, binding));
}
