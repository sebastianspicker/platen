import { basename, extname, join } from 'node:path';
import { normalizeAecCalibrationRequest, normalizeAecMaterializationRequest, normalizeAecMeasurementRequest, validateAecCalibrationResult, validateAecMaterializationResult, validateAecMeasurementResult } from '../../src/core/aec-contract.js';
import { digestFile } from './document-store.mjs';
import { executeOfflineSignatureInspection, parsePdfInfo } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { MAX_OUTPUT_BYTES, MAX_PAGES, MAX_SOURCE_BYTES, TIMEOUT_MS, assertWorkspace, createJobSignal, preparePrivateExport, validateHelperExport } from './aec-artifact-export.mjs';
import { renderAllPages } from './aec-artifact-render.mjs';
import { createAecFinalOutput } from './aec-measure-embedding.mjs';
import { createAecMaterializationProvenance, createAecMaterializationReceipt, createAecMaterializationResult } from './aec-artifact-result.mjs';
import { SHA256, UNIT_METERS, assertGeometry, assertInsideBox, canonical, displayValue, distance, fail, hash, quantity, sameSourceBinding, sourceBinding } from './aec-artifact-validation.mjs';

/** Local-only source-bound calibration, measurement, and PDF artifact facade. */
export class AecArtifactService {
  #store; #pdf; #workspace; #poppler; #pdfkit; #clock;
  constructor({ store, pdfService, workspaceState, poppler, pdfkit = null, clock = () => new Date().toISOString() } = {}) {
    if (!store || !['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact'].every((name) => typeof store[name] === 'function')) throw new TypeError('AecArtifactService requires a DocumentStore-compatible store.');
    if (!pdfService || typeof pdfService.inspectStructure !== 'function') throw new TypeError('AecArtifactService requires PdfService.');
    if (!workspaceState || !['snapshot', 'createEntity'].every((name) => typeof workspaceState[name] === 'function')) throw new TypeError('AecArtifactService requires WorkspaceStateStore.');
    if (!poppler || typeof poppler.execute !== 'function') throw new TypeError('AecArtifactService requires a Poppler adapter.');
    if (pdfkit !== null && typeof pdfkit.applyAecMeasurement !== 'function') throw new TypeError('pdfkit must support applyAecMeasurement or be null.');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    this.#store = store; this.#pdf = pdfService; this.#workspace = workspaceState; this.#poppler = poppler; this.#pdfkit = pdfkit; this.#clock = clock;
  }
  get nativeAvailable() { return Boolean(this.#pdfkit); }
  async #binding(documentId, sourceSha256, page, signal) { const document = this.#store.getDocument(documentId); if (!SHA256.test(sourceSha256) || document.sha256 !== sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'AEC source digest does not match the open PDF.', 409); await this.#store.verifySource(documentId); const evidence = await this.#pdf.inspectStructure(documentId, { firstPage: page, lastPage: page, signal }); if (!Array.isArray(evidence.pageBoxes) || evidence.pageBoxes.length !== 1 || evidence.pageBoxes[0].page !== page) fail('AEC_PAGE_EVIDENCE_INVALID', 'The local PDF engine did not return exact page geometry.', 502); return Object.freeze({ document, binding: sourceBinding(document, evidence.pageBoxes[0]) }); }
  async calibrate(documentId, request, { signal } = {}) {
    let input; try { input = normalizeAecCalibrationRequest(request); } catch (error) { if (error?.code === 'AEC_CONTRACT_INVALID') fail('INVALID_AEC_CALIBRATION', error.message, 400, error); throw error; }
    const { document, binding } = await this.#binding(documentId, input.sourceSha256, input.page, signal); assertInsideBox(input.points, binding.box);
    const metersPerPdfPoint = (input.realLength * UNIT_METERS[input.unit]) / distance(input.points[0], input.points[1]); if (!Number.isFinite(metersPerPdfPoint) || metersPerPdfPoint <= 0) fail('AEC_CALIBRATION_INVALID', 'AEC scale calculation is not finite.');
    const calibration = { schemaVersion: 2, id: input.id, type: 'scale-calibration', source: binding, segment: input.points, knownLength: { value: input.realLength, unit: input.unit }, metersPerPdfPoint, label: input.label, createdAt: this.#clock() };
    const state = this.#workspace.createEntity(documentId, 'measurements', calibration, { expectedRevision: input.expectedRevision }); return validateAecCalibrationResult({ kind: 'source-bound-aec-calibration', schemaVersion: 1, sourceDigest: document.sha256, workspaceRevision: state.revision, calibration });
  }
  async measure(documentId, request, { signal } = {}) {
    let input; try { input = normalizeAecMeasurementRequest(request); } catch (error) { if (error?.code === 'AEC_CONTRACT_INVALID') fail('INVALID_AEC_MEASUREMENT', error.message, 400, error); throw error; }
    const state = this.#workspace.snapshot(documentId); if (state.revision !== input.expectedRevision) fail('REVISION_CONFLICT', 'Workspace state revision does not match the expected revision.', 409);
    const { document, binding } = await this.#binding(documentId, input.sourceSha256, input.page, signal); assertInsideBox(input.points, binding.box); assertGeometry(input.kind, input.points);
    let calibration = null; if (input.kind !== 'count') { calibration = state.namespaces.measurements.find((record) => record.id === input.calibrationId); if (!calibration || calibration.schemaVersion !== 2 || calibration.type !== 'scale-calibration') fail('AEC_CALIBRATION_NOT_FOUND', 'Measurement requires a source-bound scale calibration.', 404); if (!sameSourceBinding(calibration.source, binding)) fail('AEC_CALIBRATION_STALE', 'Scale calibration belongs to different PDF bytes or page geometry.', 409); }
    const siValue = quantity(input.kind, input.points, calibration?.metersPerPdfPoint ?? 1); const dimension = input.kind === 'area' ? 'area' : input.kind === 'count' ? 'count' : 'length'; const siUnit = input.kind === 'area' ? 'm2' : input.kind === 'count' ? 'count' : 'm';
    const base = { schemaVersion: 2, id: input.id, type: 'measurement', source: binding, calibrationId: calibration?.id ?? null, kind: input.kind, geometry: { space: 'pdf-user-space-v1', points: input.points }, result: { dimension, siValue, siUnit, displayValue: displayValue(siValue, input.displayUnit), displayUnit: input.displayUnit }, label: input.label };
    const measurement = { ...base, provenanceSha256: hash(canonical(base)), createdAt: this.#clock() }; const next = this.#workspace.createEntity(documentId, 'measurements', measurement, { expectedRevision: input.expectedRevision }); return validateAecMeasurementResult({ kind: 'source-bound-aec-measurement', schemaVersion: 1, sourceDigest: document.sha256, workspaceRevision: next.revision, measurement });
  }
  async materialize(documentId, request, { signal: externalSignal } = {}) {
    let input; try { input = normalizeAecMaterializationRequest(request); } catch (error) { if (error?.code === 'AEC_CONTRACT_INVALID') fail('INVALID_AEC_MATERIALIZATION', error.message, 400, error); throw error; }
    if (!this.#pdfkit) fail('AEC_NATIVE_UNAVAILABLE', 'Pinned local PDFKit AEC publication is unavailable.', 503);
    const state = this.#workspace.snapshot(documentId); if (state.revision !== input.expectedRevision) fail('REVISION_CONFLICT', 'Workspace state revision does not match the expected revision.', 409);
    const measurement = state.namespaces.measurements.find((record) => record.id === input.measurementId); if (!measurement || measurement.schemaVersion !== 2 || measurement.type !== 'measurement') fail('AEC_MEASUREMENT_NOT_FOUND', 'A source-bound measurement record was not found.', 404);
    const { document, binding } = await this.#binding(documentId, input.sourceSha256, measurement.source.page, externalSignal); if (!sameSourceBinding(measurement.source, binding)) fail('AEC_MEASUREMENT_STALE', 'Measurement belongs to different PDF bytes or page geometry.', 409); if (document.size > MAX_SOURCE_BYTES) fail('AEC_NATIVE_INPUT_TOO_LARGE', 'AEC native publication is limited to 128 MiB source PDFs.', 413);
    const calibration = measurement.calibrationId === null ? null : state.namespaces.measurements.find((record) => record.id === measurement.calibrationId); if (measurement.kind !== 'count' && (!calibration || calibration.schemaVersion !== 2 || calibration.type !== 'scale-calibration' || !sameSourceBinding(calibration.source, binding))) fail('AEC_CALIBRATION_STALE', 'Measurement calibration is unavailable or stale.', 409);
    const job = createJobSignal(externalSignal); let workspace = null;
    try {
      const sourcePath = this.#store.getSourcePath(documentId); const sourceInspection = parsePdfInfo((await this.#poppler.execute('inspect', { input: sourcePath }, { signal: job.signal, timeoutMs: TIMEOUT_MS, maxStdoutBytes: 512 * 1024, maxStderrBytes: 128 * 1024 })).stdout);
      if (sourceInspection.pageCount > MAX_PAGES || String(sourceInspection.encrypted).toLowerCase() !== 'no' || String(sourceInspection.form).toLowerCase() !== 'none' || String(sourceInspection.javascript).toLowerCase() !== 'no') fail('AEC_NATIVE_SOURCE_UNSUPPORTED', 'AEC native publication requires an unencrypted, form-free PDF without JavaScript and at most 100 pages.', 422);
      workspace = await this.#store.createJobWorkspace(documentId); let signatures; try { signatures = await executeOfflineSignatureInspection(this.#poppler, { input: sourcePath, nssDirectory: workspace, signal: job.signal, timeoutMs: TIMEOUT_MS }); } catch (error) { if (job.signal.aborted) throw error; fail('AEC_NATIVE_SIGNED_SOURCE_UNSUPPORTED', 'AEC native publication rejects signed or indeterminate-signature PDFs.', 422, error); } if (signatures.status !== 'unsigned' || signatures.signatureCount !== 0) fail('AEC_NATIVE_SIGNED_SOURCE_UNSUPPORTED', 'AEC native publication rejects signed PDFs.', 422);
      const prepared = await preparePrivateExport({ store: this.#store, documentId, document, workspace, measurement, calibration }); await assertWorkspace(workspace, ['input.pdf', 'request.json']); const nativeReceipt = await this.#pdfkit.applyAecMeasurement({ workspacePath: workspace, requestPath: prepared.requestPath }, { signal: job.signal, timeoutMs: TIMEOUT_MS }); const nativeOutputSha256 = await validateHelperExport({ workspace, ...prepared, document, receipt: nativeReceipt, measurement, pageCount: sourceInspection.pageCount });
      const finalOutputPath = join(workspace, 'final-output.pdf');
      const embedding = await createAecFinalOutput({ nativeOutputPath: prepared.outputPath, finalOutputPath, nativeOutputSha256, measurement, calibration, maximumSourceBytes: MAX_SOURCE_BYTES, maximumOutputBytes: MAX_OUTPUT_BYTES, signal: job.signal });
      const outputInspection = parsePdfInfo((await this.#poppler.execute('inspect', { input: finalOutputPath }, { cwd: workspace, signal: job.signal, timeoutMs: TIMEOUT_MS, maxStdoutBytes: 512 * 1024, maxStderrBytes: 128 * 1024 })).stdout); if (outputInspection.pageCount !== sourceInspection.pageCount || String(outputInspection.encrypted).toLowerCase() !== 'no' || String(outputInspection.form).toLowerCase() !== 'none' || String(outputInspection.javascript).toLowerCase() !== 'no') fail('AEC_NATIVE_POSTFLIGHT_INVALID', 'AEC native publication changed page count or passive-content safety state.', 502);
      await renderAllPages({ poppler: this.#poppler, workspace, outputPath: finalOutputPath, pageCount: outputInspection.pageCount, signal: job.signal, workspaceFiles: ['final-output.pdf'] }); if (await digestFile(finalOutputPath) !== embedding.outputSha256) fail('AEC_NATIVE_OUTPUT_INVALID', 'Final AEC output changed during validation.', 502); await this.#store.verifySource(documentId);
      const receipt = createAecMaterializationReceipt(nativeReceipt, embedding);
      const provenance = createAecMaterializationProvenance({ documentId, document, measurement, receipt });
      const stem = basename(document.displayName, extname(document.displayName)); const artifact = await this.#store.promotePdfArtifact(documentId, finalOutputPath, { displayName: `${stem}-aec-measurement.pdf`, operation: provenance, expectedSha256: embedding.outputSha256, signal: job.signal });
      return validateAecMaterializationResult(createAecMaterializationResult({ document, measurement, artifact, nativeReceipt, receipt }));
    } catch (error) { if (job.timedOut) fail('AEC_NATIVE_TIMEOUT', 'AEC native publication exceeded its two-minute deadline.', 504, error); if (externalSignal?.aborted) fail('JOB_CANCELLED', 'AEC native publication was cancelled.', 499, error); if (error instanceof HostError) throw error; fail('AEC_NATIVE_FAILED', 'The pinned local PDFKit helper could not publish and validate the AEC measurement.', 502, error); } finally { job.dispose(); if (workspace) await this.#store.cleanupJob(workspace); }
  }
}
