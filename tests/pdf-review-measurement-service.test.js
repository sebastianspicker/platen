import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfReviewMeasurementService, calculatePdfReviewMeasurement } from '../scripts/host/pdf-review-measurement-service.mjs';
import { PDF_REVIEW_MEASUREMENT_PROFILE, normalizePdfReviewMeasurement } from '../scripts/host/pdf-review-measurement-contract.mjs';
import { assertGeometry, assertInsideBox } from '../scripts/host/aec-artifact-validation.mjs';

function sourcePdf() {
  const bodies = [
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 3 0 R /Annots 4 0 R >>',
    '<< /Type /Pages /MediaBox [0 0 612 792] /Count 1 /Kids [1 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream', '[5 0 R]',
    '<< /Type /Annot /Subtype /Line /Rect [71.5 71.5 144.5 72.5] /L [72 72 144 72] >>',
    '<< /Type /Catalog /Pages 2 0 R >>',
  ];
  const chunks = ['%PDF-1.3\n']; const offsets = [0];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach((offset) => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size ${bodies.length + 1} /Root 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function request(sourceSha256) {
  return { profile: PDF_REVIEW_MEASUREMENT_PROFILE, sourceSha256, expectedRevision: 0, id: 'review-1', page: 1, kind: 'distance', points: [{ x: 72, y: 72 }, { x: 144, y: 72 }], calibration: { id: 'scale-1', points: [{ x: 72, y: 72 }, { x: 144, y: 72 }], realLength: 1, unit: 'ft' }, label: 'Wall length', displayUnit: 'ft' };
}

test('review measurement contract computes no caller-supplied quantity and rejects accessors/proxies and unsupported kinds', () => {
  const value = request('a'.repeat(64));
  const normalized = normalizePdfReviewMeasurement(value);
  assert.equal(normalized.kind, 'distance');
  assert.equal(Object.hasOwn(normalized, 'quantity'), false);
  value.points[0].x = 999;
  assert.equal(normalized.points[0].x, 72);
  assert.throws(() => normalizePdfReviewMeasurement(new Proxy(value, {})), { code: 'INVALID_PDF_REVIEW_MEASUREMENT' });
  const accessor = { ...value, get label() { return 'bad'; } };
  assert.throws(() => normalizePdfReviewMeasurement(accessor), { code: 'INVALID_PDF_REVIEW_MEASUREMENT' });
  assert.throws(() => normalizePdfReviewMeasurement({ ...value, kind: 'count' }), { code: 'INVALID_PDF_REVIEW_MEASUREMENT' });
  for (const kind of ['volume', 'angle', 'radius']) assert.throws(() => normalizePdfReviewMeasurement({ ...value, kind }), { code: 'INVALID_PDF_REVIEW_MEASUREMENT' });
  assert.throws(() => assertGeometry('area', [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }]), { code: 'AEC_GEOMETRY_SELF_INTERSECTS' });
  assert.throws(() => assertGeometry('perimeter', [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }]), { code: 'AEC_GEOMETRY_DEGENERATE' });
  assert.throws(() => assertInsideBox([{ x: 11, y: 0 }], { left: 0, bottom: 0, right: 10, top: 10 }), { code: 'AEC_POINT_OUTSIDE_PAGE' });
});

test('review measurement derivation is deterministic for calibrated distance, perimeter, and area', () => {
  const binding = { sha256: 'a'.repeat(64), page: 1, displayBox: 'crop', box: { left: 0, bottom: 0, right: 612, top: 792 }, rotation: 0, geometrySha256: 'b'.repeat(64) };
  const base = request(binding.sha256);
  const distanceResult = calculatePdfReviewMeasurement(base, binding);
  assert.equal(distanceResult.measurement.result.siValue, 0.3048);
  const perimeterResult = calculatePdfReviewMeasurement({ ...base, id: 'review-perimeter', kind: 'perimeter', points: [{ x: 72, y: 72 }, { x: 144, y: 72 }, { x: 144, y: 144 }] }, binding);
  assert.equal(perimeterResult.measurement.result.siValue, Number(((72 + 72 + Math.hypot(72, 72)) * (0.3048 / 72)).toPrecision(15)));
  const areaResult = calculatePdfReviewMeasurement({ ...base, id: 'review-area', kind: 'area', points: [{ x: 72, y: 72 }, { x: 144, y: 72 }, { x: 144, y: 144 }, { x: 72, y: 144 }], displayUnit: 'ft2' }, binding);
  assert.equal(areaResult.measurement.result.siValue, Number((72 * 72 * (0.3048 / 72) ** 2).toPrecision(15)));
});

test('review measurement service is source/revision bound and publishes a separate validated artifact', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-review-measurement-')); context.after(() => rm(root, { recursive: true, force: true }));
  const source = sourcePdf(); const sha = createHash('sha256').update(source).digest('hex'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  const workspaceState = { snapshot: () => ({ revision: 0 }) }; let promoted = null; let deleted = 0;
  const store = { getDocument: () => ({ id: '11111111-1111-4111-8111-111111111111', displayName: 'drawing.pdf', sha256: sha, size: source.length }), getSourcePath: () => sourcePath, verifySource: async () => {}, createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; }, cleanupJob: async (path) => rm(path, { recursive: true, force: true }), promotePdfArtifact: async (_id, path, options) => { const bytes = await readFile(path); promoted = { id: '22222222-2222-4222-8222-222222222222', documentId: '11111111-1111-4111-8111-111111111111', mediaType: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), displayName: options.displayName }; return promoted; }, deleteArtifact: async () => { deleted += 1; } };
  const pdfService = { inspectStructure: async () => ({ pageBoxes: [{ page: 1, rotation: 0, boxes: { cropBox: { left: 0, bottom: 0, right: 612, top: 792 } } }] }) };
  const poppler = { async execute(operation, parameters) { if (operation === 'inspect') return { stdout: `Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\n` }; if (operation === 'verifySignatures') throw Object.assign(new Error('unsigned'), { exitCode: 2, stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '' }); if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); return { stdout: '', stderr: '' }; } throw new Error(`unexpected ${operation}`); } };
  const pdfkit = { async applyAecMeasurement({ workspacePath }) { await writeFile(join(workspacePath, 'output.pdf'), source, { mode: 0o600 }); return { schema: 'pdfkit-aec-measurement-receipt-v1', version: 1, operation: 'applyAecMeasurement', sourceSha256: sha, outputSha256: sha, measurementId: 'review-1', page: 1, kind: 'distance', quantity: 0.3048, unit: 'm', calibrationId: 'scale-1', annotationCount: 1, annotationSubtypes: ['line'], measurementDictionaryEmbedded: false, pageCount: 1 }; } };
  const service = new PdfReviewMeasurementService({ store, pdfService, poppler, pdfkit, workspaceState });
  const result = await service.create(store.getDocument().id, request(sha));
  assert.equal(result.kind, 'pdf-review-measurement'); assert.equal(result.receipt.measurementDictionaryEmbedded, true); assert.equal(result.artifact.sha256, result.receipt.outputSha256); assert.equal(promoted.displayName, 'drawing-review-measurement.pdf');
  await assert.rejects(service.create(store.getDocument().id, { ...request(sha), sourceSha256: 'b'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });

  const stale = new PdfReviewMeasurementService({ store, pdfService, poppler, pdfkit, workspaceState: { snapshot: () => ({ revision: 1 }) } });
  await assert.rejects(stale.create(store.getDocument().id, request(sha)), { code: 'REVISION_CONFLICT', status: 409 });
  const controller = new AbortController(); controller.abort(new Error('cancelled-before-native'));
  let nativeCalls = 0;
  const cancelled = new PdfReviewMeasurementService({ store, pdfService, poppler, workspaceState, pdfkit: { applyAecMeasurement: async (...args) => { nativeCalls += 1; return pdfkit.applyAecMeasurement(...args); } } });
  await assert.rejects(cancelled.create(store.getDocument().id, request(sha), { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(nativeCalls, 0);

  const originalCleanup = store.cleanupJob;
  store.cleanupJob = async () => { throw new Error('cleanup-failure'); };
  await assert.rejects(service.create(store.getDocument().id, request(sha)), { code: 'PDF_REVIEW_MEASUREMENT_CLEANUP_FAILED', status: 500 });
  assert.equal(deleted, 1, 'a promoted artifact is revoked when workspace cleanup fails');
  store.cleanupJob = originalCleanup;
});

async function hostileScenario(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-review-measurement-hostile-')); context.after(() => rm(root, { recursive: true, force: true }));
  const source = sourcePdf(); const sha = createHash('sha256').update(source).digest('hex'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, source, { mode: 0o600 });
  let verifies = 0; let deleted = 0; const controller = new AbortController();
  const store = {
    getDocument: () => ({ id: '11111111-1111-4111-8111-111111111111', displayName: 'drawing.pdf', sha256: sha, size: source.length }), getSourcePath: () => sourcePath,
    verifySource: async () => { verifies += 1; if (options.mutateSource && verifies === 2) await writeFile(sourcePath, Buffer.concat([source, Buffer.from('drift')]), { mode: 0o600 }); if (createHash('sha256').update(await readFile(sourcePath)).digest('hex') !== sha) throw new Error('source drift'); },
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; },
    cleanupJob: async (path) => { await rm(path, { recursive: true, force: true }); if (options.cleanupFailure) throw new Error('cleanup failure'); },
    promotePdfArtifact: async (_id, path, promotion) => { const bytes = await readFile(path); if (options.cancelAfterPromotion) controller.abort(new Error('cancel-after-promotion')); return { id: '22222222-2222-4222-8222-222222222222', documentId: '11111111-1111-4111-8111-111111111111', mediaType: 'application/pdf', size: bytes.length, sha256: options.forgePromotion ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), displayName: promotion.displayName }; },
    deleteArtifact: async () => { deleted += 1; if (options.revocationFailure) throw new Error('revocation failure'); },
  };
  const pdfService = { inspectStructure: async () => ({ pageBoxes: [{ page: 1, rotation: 0, boxes: { cropBox: { left: 0, bottom: 0, right: 612, top: 792 } } }] }) };
  const poppler = { async execute(operation, parameters) { if (operation === 'inspect') return { stdout: 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\n' }; if (operation === 'verifySignatures') throw Object.assign(new Error('unsigned'), { exitCode: 2, stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '' }); if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); return { stdout: '', stderr: '' }; } throw new Error(`unexpected ${operation}`); } };
  const pdfkit = { async applyAecMeasurement({ workspacePath }) { if (options.nativeFailure) throw new Error('native helper failure'); await writeFile(join(workspacePath, 'output.pdf'), source, { mode: 0o600 }); return { schema: 'pdfkit-aec-measurement-receipt-v1', version: 1, operation: 'applyAecMeasurement', sourceSha256: sha, outputSha256: sha, measurementId: 'review-1', page: 1, kind: 'distance', quantity: 0.3048, unit: 'm', calibrationId: 'scale-1', annotationCount: 1, annotationSubtypes: ['line'], measurementDictionaryEmbedded: false, pageCount: 1 }; } };
  const service = new PdfReviewMeasurementService({ store, pdfService, poppler, pdfkit, workspaceState: { snapshot: () => ({ revision: 0 }) } });
  return { service, documentId: store.getDocument().id, request: request(sha), controller, deleted };
}

test('review measurement service fails closed for mid-operation source drift, native failure, forged promotion, post-promotion cancellation, and cleanup/revocation failure', async (context) => {
  for (const [options, expected] of [
    [{ mutateSource: true }, { code: 'PDF_REVIEW_MEASUREMENT_FAILED', status: 502 }],
    [{ nativeFailure: true }, { code: 'PDF_REVIEW_MEASUREMENT_FAILED', status: 502 }],
    [{ forgePromotion: true }, { code: 'PDF_REVIEW_MEASUREMENT_OUTPUT_INVALID', status: 502 }],
  ]) {
    const fixture = await hostileScenario(context, options);
    await assert.rejects(fixture.service.create(fixture.documentId, fixture.request), expected);
  }
  const cancelled = await hostileScenario(context, { cancelAfterPromotion: true });
  await assert.rejects(cancelled.service.create(cancelled.documentId, cancelled.request, { signal: cancelled.controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  const cleanup = await hostileScenario(context, { cleanupFailure: true, revocationFailure: true });
  await assert.rejects(cleanup.service.create(cleanup.documentId, cleanup.request), (error) => error instanceof AggregateError && error.errors.length === 2);
});
