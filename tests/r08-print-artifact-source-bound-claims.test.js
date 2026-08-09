import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfPrinterMarksService } from '../scripts/host/pdf-printer-marks-service.mjs';
import { PrepressService } from '../scripts/host/prepress-service.mjs';
import { deliverProfessionalCapability, listProfessionalHandlers } from '../scripts/host/professional-capability/index.mjs';
import { createProfessionalPrintDelivery } from '../scripts/host/professional-capability/standards-preflight-print.mjs';
import { makeMultiPagePdf } from './pdf-fixture.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function fixture(t, { rotated = false, tamper = false, drift = false, forged = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r08-print-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const sourcePdf = makeMultiPagePdf(['ONE', 'TWO', 'THREE', 'FOUR'], {
    rotations: rotated ? [0, 90, 0, 0] : [0, 0, 0, 0],
    cropBoxes: Array.from({ length: 4 }, () => [0, 0, 612, 792]),
    bleedBoxes: Array.from({ length: 4 }, () => [0, 0, 612, 792]),
    trimBoxes: Array.from({ length: 4 }, () => [9, 9, 603, 783]),
  });
  const document = await store.createDocument({ stream: Readable.from([sourcePdf]), displayName: 'r08-source.pdf' });
  const sourceSha256 = document.sha256;
  const pdfService = {
    inspect: async () => ({ pageCount: 4, encrypted: 'no', javascript: 'no', form: 'none' }),
    inspectPage: async () => ({ widthPoints: 612, heightPoints: 792 }),
    inspectStructure: async () => ({ sourceDigest: sourceSha256, pageRange: { firstPage: 1, lastPage: 4, truncated: false }, pageBoxes: Array.from({ length: 4 }, (_, index) => ({ page: index + 1, widthPoints: 612, heightPoints: 792, rotation: rotated && index === 1 ? 90 : 0, boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792, width: 612, height: 792 }, cropBox: { left: 0, bottom: 0, right: 612, top: 792, width: 612, height: 792 } } })) }),
  };
  const poppler = {
    execute: async (operation, parameters) => {
      if (operation === 'inspect') return { stdout: 'Pages: 1\nEncrypted: no\nForm: none\nJavaScript: no\n' };
      if (operation === 'inspectPageBoxes') return { stdout: 'Page 1 size: 1224 x 1584 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 1224 1584\nPage 1 CropBox: 0 0 1224 1584\n' };
      if (operation === 'extractText') return { stdout: 'ONE\nTWO\nTHREE\nFOUR\n' };
      if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, PNG); return { stdout: '' }; }
      throw new Error(`unexpected poppler operation ${operation}`);
    },
  };
  const ghostscript = { probe: async () => ({ name: 'Ghostscript', version: 'r08-deterministic' }), execute: async (_operation, parameters) => { await writeFile(parameters.output, Buffer.concat([sourcePdf, Buffer.from('\n%R08-IMPOSITION\n')])); return { stdout: '' }; } };
  const prepress = new PrepressService({ store, pdfService, poppler, ghostscript, imageMagick: { execute: async () => {} } });
  const realPrinterMarks = new PdfPrinterMarksService({ store });
  if (forged) {
    const originalDelete = store.deleteArtifact.bind(store);
    store.deleteArtifact = async (id) => { if (id !== 'forged') return originalDelete(id); };
  }
  const printerMarks = forged === 'bleed' ? { async create() { return { kind: 'pdf-printer-marks', sourceDigest: '0'.repeat(64), artifact: { id: 'forged', sha256: 'f'.repeat(64) }, pages: [], evidence: { localOnly: true }, limitations: ['forged'] }; } } : realPrinterMarks;
  const imposed = forged === 'imposition' ? { async createImposition() { return { kind: 'imposition-artifact', sourceDigest: '0'.repeat(64), artifact: { id: 'forged', sha256: 'f'.repeat(64) }, layout: { id: '2x2', across: 2, down: 2, marks: 'none', sheetCount: 1 }, receipt: { engine: { name: 'Ghostscript' }, pageCount: 1, textExtractionEquivalent: true, everySheetRendered: true, pdfXValidated: false }, authoritative: false, limitations: ['forged'] }; } } : prepress;
  if (tamper || drift) {
    const originalPromote = store.promotePdfArtifact.bind(store);
    store.promotePdfArtifact = async (...args) => {
      const artifact = await originalPromote(...args);
      const retained = store.getArtifact(artifact.id);
      if (tamper) await writeFile(retained.filePath, Buffer.concat([await readFile(retained.filePath), Buffer.from('tamper')]));
      if (drift) await writeFile(store.getSourcePath(document.id), Buffer.concat([sourcePdf, Buffer.from('drift')]));
      return artifact;
    };
  }
  const professional = createProfessionalPrintDelivery({ store, services: { prepress: imposed, printerMarks }, deliver: deliverProfessionalCapability, list: listProfessionalHandlers });
  return { store, document, sourcePdf, sourceSha256, professional };
}

test('print.bleed-marks is a retained source-bound passive crop-mark artifact', async (t) => {
  const f = await fixture(t); const before = await readFile(f.store.getSourcePath(f.document.id));
  const outcome = await f.professional.deliver('print.bleed-marks', { documentId: f.document.id, sourceSha256: f.sourceSha256, bleedPoints: 9, markPages: [1, 3] });
  assert.equal(outcome.ok, true); assert.equal(outcome.cropMarksApplied, true); assert.equal(outcome.colorBarsApplied, false); assert.equal(outcome.registrationMarksApplied, false); assert.equal(outcome.authoritative, false); assert.equal(outcome.certified, false);
  assert.equal(outcome.sourceSha256, f.sourceSha256); assert.equal(outcome.pdf.subarray(0, before.length).equals(before), true); assert.equal(createHash('sha256').update(outcome.pdf).digest('hex'), outcome.outputSha256); assert.equal(outcome.proof.sourcePrefixPreserved, true); assert.equal(outcome.proof.outputDigestBound, true); assert.equal(outcome.pdf.length > before.length, true);
  assert.deepEqual(outcome.proof.pages.map(({ page }) => page), [1, 3]); assert.ok(outcome.proof.pages.every(({ lines, trimBox, bleedBox }) => lines.every((line) => line.every(Number.isFinite)) && trimBox[0] - bleedBox[0] === 9));
  assert.match(outcome.limitations.join(' '), /does not provide trapping/u); assert.match(outcome.limitations.join(' '), /imposition/u); assert.match(outcome.limitations.join(' '), /PDF\/X/u); assert.deepEqual(await readFile(f.store.getSourcePath(f.document.id)), before);
});

test('print.imposition is fixed upper-left row-major N-up with source-bound sheet proof', async (t) => {
  const f = await fixture(t); const outcome = await f.professional.deliver('print.imposition', { documentId: f.document.id, sourceSha256: f.sourceSha256, nUp: 4, layout: '2x2', marks: false });
  assert.equal(outcome.ok, true); assert.equal(outcome.nUp, 4); assert.equal(outcome.sourceDigest, f.sourceSha256); assert.equal(outcome.layout.order, 'upper-left-row-major'); assert.deepEqual(outcome.layout.sheet, { widthPoints: 1224, heightPoints: 1584 }); assert.equal(outcome.layout.marks, 'none'); assert.equal(outcome.receipt.pageCount, 1); assert.equal(outcome.receipt.textExtractionEquivalent, true); assert.equal(outcome.receipt.everySheetRendered, true); assert.equal(outcome.receipt.pdfXValidated, false); assert.equal(outcome.authoritative, false); assert.match(outcome.receipt.outputSha256, /^[a-f0-9]{64}$/u);
  assert.equal(f.store.getArtifact(outcome.artifactId).sha256, outcome.receipt.outputSha256); assert.equal(f.store.getArtifact(outcome.artifactId).operation.inputs[0].sha256, f.sourceSha256); assert.equal(f.store.getArtifact(outcome.artifactId).operation.validation.passed, true);
  assert.match(outcome.limitations.join(' '), /not booklet/u); assert.match(outcome.limitations.join(' '), /not.*creep/u); assert.match(outcome.limitations.join(' '), /Printer marks are unavailable/u); assert.match(outcome.limitations.join(' '), /rasterize unsupported/u);
});

test('professional print delivery rejects drift, cancellation, forged receipts, tampered artifacts, and unsupported options', async (t) => {
  const drift = await fixture(t, { drift: true }); await assert.rejects(drift.professional.deliver('print.bleed-marks', { documentId: drift.document.id, sourceSha256: drift.sourceSha256, bleedPoints: 9, markPages: [1] }), { code: 'SOURCE_INTEGRITY_FAILED', status: 500 });
  const cancelled = await fixture(t); await assert.rejects(cancelled.professional.deliver('print.bleed-marks', { documentId: cancelled.document.id, sourceSha256: cancelled.sourceSha256, bleedPoints: 9, markPages: [1], signal: AbortSignal.abort() }), { code: 'JOB_CANCELLED', status: 499 });
  const forgedBleed = await fixture(t, { forged: 'bleed' }); await assert.rejects(forgedBleed.professional.deliver('print.bleed-marks', { documentId: forgedBleed.document.id, sourceSha256: forgedBleed.sourceSha256, bleedPoints: 9, markPages: [1] }), { code: 'PRINTER_MARKS_OUTPUT_INVALID', status: 502 });
  const forgedImposition = await fixture(t, { forged: 'imposition' }); await assert.rejects(forgedImposition.professional.deliver('print.imposition', { documentId: forgedImposition.document.id, sourceSha256: forgedImposition.sourceSha256, layout: '2x2', nUp: 4, marks: false }), { code: 'IMPOSITION_OUTPUT_INVALID', status: 502 });
  const tampered = await fixture(t, { tamper: true }); await assert.rejects(tampered.professional.deliver('print.bleed-marks', { documentId: tampered.document.id, sourceSha256: tampered.sourceSha256, bleedPoints: 9, markPages: [1] }), { code: 'PRINTER_MARKS_ARTIFACT_REVOKED', status: 409 });
  const rotated = await fixture(t, { rotated: true }); await assert.rejects(rotated.professional.deliver('print.imposition', { documentId: rotated.document.id, sourceSha256: rotated.sourceSha256, layout: '2x2', nUp: 4, marks: false }), { code: 'IMPOSITION_GEOMETRY_UNSUPPORTED', status: 422 });
  const marks = await fixture(t); await assert.rejects(marks.professional.deliver('print.imposition', { documentId: marks.document.id, sourceSha256: marks.sourceSha256, layout: '2x2', nUp: 4, marks: true }), { code: 'PRINTER_MARKS_UNSUPPORTED', status: 422 });
  const bleedBounds = await fixture(t); await assert.rejects(bleedBounds.professional.deliver('print.bleed-marks', { documentId: bleedBounds.document.id, sourceSha256: bleedBounds.sourceSha256, bleedPoints: 3, markPages: [1] }), { code: 'INVALID_BLEED', status: 400 });
});
