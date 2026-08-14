import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AecArtifactService } from '../scripts/host/aec-artifact-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function classicLineMarkupPdf() {
  const bodies = [
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 3 0 R /Annots 4 0 R >>',
    '<< /Type /Pages /MediaBox [0 0 612 792] /Count 1 /Kids [1 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '[5 0 R]',
    '<< /Type /Annot /Subtype /Line /Rect [-0.5 -0.5 72.5 0.5] /L [0 0 72 0] /Contents (AEC distance) >>',
    '<< /Type /Catalog /Pages 2 0 R >>',
  ];
  const chunks = ['%PDF-1.3\n']; const offsets = [0];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${bodies.length + 1} /Root 6 0 R /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

async function setup(context) {
  const store = await new DocumentStore({ root: mkdtempSync(join(tmpdir(), 'platen-aec-artifact-')) }).initialize();
  context.after(() => store.dispose());
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('AEC drawing')]), displayName: 'drawing.pdf' });
  const workspace = new WorkspaceStateStore(store);
  const geometry = { left: 0, bottom: 0, right: 612, top: 792 };
  const pdfService = { inspectStructure: async (_documentId, { firstPage }) => ({
    pageBoxes: [{ page: firstPage, rotation: 0, boxes: { cropBox: { ...geometry } } }],
  }) };
  const service = new AecArtifactService({ store, workspaceState: workspace, pdfService, poppler: { execute() {} } });
  return { service, store, workspace, document, geometry, pdfService };
}

function calibrationRequest(document, overrides = {}) {
  return {
    schemaVersion: 1, sourceSha256: document.sha256, expectedRevision: 0,
    id: 'calibration-1', page: 1, points: [{ x: 0, y: 0 }, { x: 72, y: 0 }],
    realLength: 1, unit: 'ft', label: 'Plan scale', ...overrides,
  };
}

function measurementRequest(document, overrides = {}) {
  return {
    schemaVersion: 1, sourceSha256: document.sha256, expectedRevision: 1,
    id: 'measurement-1', page: 1, kind: 'distance',
    points: [{ x: 0, y: 0 }, { x: 72, y: 0 }], calibrationId: 'calibration-1',
    label: 'Wall length', displayUnit: 'ft', ...overrides,
  };
}

test('source-bound AEC calibration preserves units and calculates exact SI and display quantities', async (context) => {
  const { service, document } = await setup(context);
  const calibration = await service.calibrate(document.id, calibrationRequest(document));
  assert.equal(calibration.workspaceRevision, 1);
  assert.equal(calibration.calibration.metersPerPdfPoint, 0.3048 / 72);
  assert.equal(calibration.calibration.source.displayBox, 'crop');
  assert.match(calibration.calibration.source.geometrySha256, /^[a-f0-9]{64}$/);

  const distance = await service.measure(document.id, measurementRequest(document));
  assert.equal(distance.workspaceRevision, 2);
  assert.equal(distance.measurement.result.siValue, 0.3048);
  assert.equal(distance.measurement.result.siUnit, 'm');
  assert.equal(distance.measurement.result.displayValue, 1);
  assert.equal(distance.measurement.result.displayUnit, 'ft');

  const area = await service.measure(document.id, measurementRequest(document, {
    expectedRevision: 2, id: 'measurement-area', kind: 'area',
    points: [{ x: 0, y: 0 }, { x: 72, y: 0 }, { x: 72, y: 72 }, { x: 0, y: 72 }],
    label: 'Room area', displayUnit: 'ft2',
  }));
  assert.equal(area.measurement.result.siValue, 0.09290304);
  assert.equal(area.measurement.result.displayValue, 1);

  const count = await service.measure(document.id, measurementRequest(document, {
    expectedRevision: 3, id: 'measurement-count', kind: 'count',
    points: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }],
    calibrationId: null, label: 'Door count', displayUnit: 'count',
  }));
  assert.equal(count.measurement.calibrationId, null);
  assert.equal(count.measurement.result.siValue, 3);
  assert.equal(count.measurement.result.displayValue, 3);
});

test('AEC geometry rejects stale bindings, out-of-box points, degenerate paths, self-intersections, and stale revisions before mutation', async (context) => {
  const { service, document, geometry, workspace } = await setup(context);
  await service.calibrate(document.id, calibrationRequest(document));
  await assert.rejects(service.measure(document.id, measurementRequest(document, {
    expectedRevision: 0,
  })), { code: 'REVISION_CONFLICT', status: 409 });
  await assert.rejects(service.measure(document.id, measurementRequest(document, {
    points: [{ x: 0, y: 0 }, { x: 700, y: 0 }],
  })), { code: 'AEC_POINT_OUTSIDE_PAGE' });
  await assert.rejects(service.measure(document.id, measurementRequest(document, {
    points: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
  })), { code: 'AEC_GEOMETRY_DEGENERATE' });
  await assert.rejects(service.measure(document.id, measurementRequest(document, {
    kind: 'area', displayUnit: 'ft2',
    points: [{ x: 0, y: 0 }, { x: 72, y: 72 }, { x: 0, y: 72 }, { x: 72, y: 0 }],
  })), { code: 'AEC_GEOMETRY_SELF_INTERSECTS' });
  assert.equal(workspace.snapshot(document.id).revision, 1);

  geometry.right = 600;
  await assert.rejects(service.measure(document.id, measurementRequest(document)), {
    code: 'AEC_CALIBRATION_STALE', status: 409,
  });
  assert.equal(workspace.snapshot(document.id).revision, 1);
});

test('legacy unbound AEC sidecars cannot be materialized as native measurement artifacts', async (context) => {
  const { store, document, workspace, pdfService } = await setup(context);
  const service = new AecArtifactService({
    store, workspaceState: workspace, pdfService,
    poppler: { execute() {} }, pdfkit: { applyAecMeasurement() {} },
  });
  workspace.createEntity(document.id, 'measurements', {
    id: 'legacy-measurement', type: 'measurement', kind: 'distance', quantity: 1, unit: 'm',
  });
  await assert.rejects(service.materialize(document.id, {
    schemaVersion: 1, sourceSha256: document.sha256, expectedRevision: 1, measurementId: 'legacy-measurement',
  }), { code: 'AEC_MEASUREMENT_NOT_FOUND', status: 404 });
});

test('native AEC export maps an externally cancelled worker to JOB_CANCELLED without publishing an artifact', async (context) => {
  const { store, document, workspace, pdfService } = await setup(context);
  const populate = new AecArtifactService({ store, workspaceState: workspace, pdfService, poppler: { execute() {} } });
  const calibration = await populate.calibrate(document.id, calibrationRequest(document));
  const measurement = await populate.measure(document.id, measurementRequest(document, { expectedRevision: calibration.workspaceRevision }));
  const controller = new AbortController(); controller.abort(new Error('caller cancelled'));
  const service = new AecArtifactService({
    store, workspaceState: workspace, pdfService, pdfkit: { applyAecMeasurement() {} },
    poppler: { async execute(_operation, _request, options) { assert.equal(options.signal.aborted, true); throw new Error('helper observed cancellation'); } },
  });
  await assert.rejects(service.materialize(document.id, {
    schemaVersion: 1, sourceSha256: document.sha256,
    expectedRevision: measurement.workspaceRevision, measurementId: measurement.measurement.id,
  }, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(workspace.snapshot(document.id).revision, measurement.workspaceRevision);
});

test('AEC materialization finalizes the PDFKit intermediate, validates the final bytes, and returns the v2 receipt', async (context) => {
  const { store, document, workspace, pdfService } = await setup(context);
  const populate = new AecArtifactService({ store, workspaceState: workspace, pdfService, poppler: { execute() {} } });
  const calibration = await populate.calibrate(document.id, calibrationRequest(document));
  const measured = await populate.measure(document.id, measurementRequest(document, { expectedRevision: calibration.workspaceRevision }));
  const nativeBytes = classicLineMarkupPdf(); const nativeOutputSha256 = createHash('sha256').update(nativeBytes).digest('hex'); const renderInputs = [];
  const poppler = { async execute(operation, parameters) {
    if (operation === 'inspect') return { stdout: 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\n' };
    if (operation === 'verifySignatures') throw Object.assign(new Error('unsigned'), { exitCode: 2, stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '' });
    if (operation === 'renderPagePng') { renderInputs.push(parameters.input); await writeFile(`${parameters.outputPrefix}.png`, PNG_SIGNATURE, { mode: 0o600 }); return { stdout: '', stderr: '' }; }
    throw new Error(`unexpected Poppler operation: ${operation}`);
  } };
  const service = new AecArtifactService({
    store, workspaceState: workspace, pdfService, poppler,
    pdfkit: { async applyAecMeasurement({ workspacePath }) { await writeFile(join(workspacePath, 'output.pdf'), nativeBytes, { mode: 0o600 }); return { schema: 'pdfkit-aec-measurement-receipt-v1', version: 1, operation: 'applyAecMeasurement', sourceSha256: document.sha256, outputSha256: nativeOutputSha256, measurementId: measured.measurement.id, page: 1, kind: 'distance', quantity: measured.measurement.result.siValue, unit: 'm', calibrationId: calibration.calibration.id, annotationCount: 1, annotationSubtypes: ['line'], measurementDictionaryEmbedded: false, pageCount: 1 }; } },
  });
  const materialized = await service.materialize(document.id, { schemaVersion: 1, sourceSha256: document.sha256, expectedRevision: measured.workspaceRevision, measurementId: measured.measurement.id });
  assert.equal(materialized.schemaVersion, 2);
  assert.equal(materialized.receipt.version, 2);
  assert.equal(materialized.receipt.measurementDictionaryEmbedded, true);
  assert.equal(materialized.receipt.measurementDictionaryScope, 'line-and-page-viewport');
  assert.equal(materialized.receipt.sourceSha256, nativeOutputSha256);
  assert.equal(materialized.artifact.sha256, materialized.receipt.outputSha256);
  assert.notEqual(materialized.artifact.sha256, nativeOutputSha256);
  assert.equal(renderInputs.length, 1);
  assert.match(renderInputs[0], /final-output\.pdf$/);
});

test('AEC materialization cancellation after finalization promotes no artifact and cleans the final output', async (context) => {
  const { store, document, workspace, pdfService } = await setup(context);
  const populate = new AecArtifactService({ store, workspaceState: workspace, pdfService, poppler: { execute() {} } });
  const calibration = await populate.calibrate(document.id, calibrationRequest(document));
  const measured = await populate.measure(document.id, measurementRequest(document, { expectedRevision: calibration.workspaceRevision }));
  const nativeBytes = classicLineMarkupPdf(); const nativeOutputSha256 = createHash('sha256').update(nativeBytes).digest('hex'); const controller = new AbortController(); let finalPath = null; let promoted = false;
  const cleanupJob = store.cleanupJob.bind(store); store.cleanupJob = async (path) => { finalPath = join(path, 'final-output.pdf'); await cleanupJob(path); assert.equal(existsSync(finalPath), false); };
  const promotePdfArtifact = store.promotePdfArtifact.bind(store); store.promotePdfArtifact = async (...args) => { promoted = true; return promotePdfArtifact(...args); };
  const poppler = { async execute(operation, parameters) {
    if (operation === 'inspect') {
      if (parameters.input.endsWith('final-output.pdf')) controller.abort(new Error('cancel after finalization'));
      return { stdout: 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\n' };
    }
    if (operation === 'verifySignatures') throw Object.assign(new Error('unsigned'), { exitCode: 2, stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '' });
    throw new Error(`unexpected Poppler operation: ${operation}`);
  } };
  const service = new AecArtifactService({
    store, workspaceState: workspace, pdfService, poppler,
    pdfkit: { async applyAecMeasurement({ workspacePath }) { await writeFile(join(workspacePath, 'output.pdf'), nativeBytes, { mode: 0o600 }); return { schema: 'pdfkit-aec-measurement-receipt-v1', version: 1, operation: 'applyAecMeasurement', sourceSha256: document.sha256, outputSha256: nativeOutputSha256, measurementId: measured.measurement.id, page: 1, kind: 'distance', quantity: measured.measurement.result.siValue, unit: 'm', calibrationId: calibration.calibration.id, annotationCount: 1, annotationSubtypes: ['line'], measurementDictionaryEmbedded: false, pageCount: 1 }; } },
  });
  await assert.rejects(service.materialize(document.id, { schemaVersion: 1, sourceSha256: document.sha256, expectedRevision: measured.workspaceRevision, measurementId: measured.measurement.id }, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(promoted, false);
  assert.notEqual(finalPath, null);
});

test('installed engines publish a source-bound AEC measurement as a separately validated inert PDF annotation', {
  skip: process.platform !== 'darwin' ? 'Apple PDFKit helper requires macOS.' : false,
}, async (context) => {
  const application = await createLocalApplication({ root: repositoryRoot, token: 'f'.repeat(64) });
  context.after(() => application.store.dispose());
  assert.equal(application.pdfkitHelper.available, true);
  const pdf = makeTextPdf('72 point calibrated AEC line');
  const document = await application.store.createDocument({ stream: Readable.from([pdf]), displayName: 'native-aec.pdf' });
  const originalBytes = readFileSync(application.store.getSourcePath(document.id));
  const calibration = await application.aecArtifacts.calibrate(document.id, calibrationRequest(document, {
    points: [{ x: 72, y: 72 }, { x: 144, y: 72 }],
  }));
  const measured = await application.aecArtifacts.measure(document.id, measurementRequest(document, {
    expectedRevision: calibration.workspaceRevision,
    points: [{ x: 72, y: 72 }, { x: 144, y: 72 }],
  }));
  const materialized = await application.aecArtifacts.materialize(document.id, {
    schemaVersion: 1, sourceSha256: document.sha256,
    expectedRevision: measured.workspaceRevision, measurementId: measured.measurement.id,
  });
  assert.equal(materialized.kind, 'pdf-native-aec-measurement');
  assert.deepEqual(materialized.receipt.annotationSubtypes, ['line']);
  assert.equal(materialized.schemaVersion, 2);
  assert.equal(materialized.receipt.measurementDictionaryEmbedded, true);
  assert.equal(materialized.artifact.sha256, materialized.receipt.outputSha256);
  assert.notEqual(materialized.artifact.sha256, document.sha256);
  assert.deepEqual(readFileSync(application.store.getSourcePath(document.id)), originalBytes);
  assert.equal(materialized.evidence.allPagesRendered, true);
});
