import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfPrinterMarksService } from '../scripts/host/pdf-printer-marks-service.mjs';
import { buildPreflightReport } from '../scripts/host/preflight-rules.mjs';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { deliverProfessionalCapability, listProfessionalHandlers } from '../scripts/host/professional-capability/index.mjs';
import {
  createProfessionalPrintDelivery,
  preflightFixups,
  preflightProfiles,
  preflightReports,
} from '../scripts/host/professional-capability/standards-preflight-print.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'platen-preflight-print-'));
  const store = await new DocumentStore({ root }).initialize();
  const sourcePdf = makeMultiPagePdf(['trimmed page'], {
    cropBoxes: [[0, 0, 612, 792]], bleedBoxes: [[0, 0, 612, 792]], trimBoxes: [[9, 9, 603, 783]],
  });
  const document = await store.createDocument({ stream: Readable.from([sourcePdf]), displayName: 'source.pdf' });
  const prepress = {
    runPreflight: async () => buildPreflightReport({ profile: 'print-review', document, inspection: { pageCount: 1, encrypted: 'no', javascript: 'no' }, structure: { sourceDigest: document.sha256, pageRange: { firstPage: 1, lastPage: 1, truncated: false }, pageBoxes: [{ widthPoints: 612, heightPoints: 792, boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792 }, bleedBox: { left: 0, bottom: 0, right: 612, top: 792 }, trimBox: { left: 9, bottom: 9, right: 603, top: 783 } } }] }, fonts: [], images: [] }),
  };
  const professional = createProfessionalPrintDelivery({
    store,
    services: { prepress, printerMarks: new PdfPrinterMarksService({ store }) },
    deliver: deliverProfessionalCapability,
    list: listProfessionalHandlers,
  });
  return { root, store, document, sourcePdf, professional };
}

function cleanup(t, f) {
  t.after(() => f.store.dispose().catch(() => {}).finally(() => rm(f.root, { recursive: true, force: true })));
}

test('composition-root preflight delivery binds the real retained source and a strict non-certifying report', async (t) => {
  const f = await fixture(); cleanup(t, f);
  const result = await f.professional.deliver('preflight.profiles', { documentId: f.document.id, profile: 'print-review', sourceSha256: f.document.sha256 });
  assert.equal(result.report.localOnly, true);
  assert.equal(result.report.authoritative, false);
  const exported = await f.professional.deliver('preflight.reports', { documentId: f.document.id, profile: 'print-review', sourceSha256: f.document.sha256 });
  assert.match(exported.xml, /report-sha256="[a-f0-9]{64}"/u);
  assert.throws(() => preflightProfiles({ prepress: Object.create(null) }), { code: 'INVALID_PRODUCTION_AUTHORITY' });
  await assert.rejects(() => preflightReports({ report: { kind: 'preflight-review', localOnly: true, authoritative: false } }), { code: 'INVALID_PRODUCTION_AUTHORITY' });
});

test('real printer-marks service is reachable only through the composition-root wrapper and rereads retained bytes', async (t) => {
  const f = await fixture(); cleanup(t, f);
  const outcome = await f.professional.deliver('print.bleed-marks', { documentId: f.document.id, sourceSha256: f.document.sha256, bleedPoints: 9, markPages: [1] });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.cropMarksApplied, true);
  assert.equal(outcome.outputSha256.length, 64);
  assert.equal(outcome.pdf.subarray(0, f.sourcePdf.length).equals(f.sourcePdf), true);
  await assert.rejects(
    () => deliverProfessionalCapability('print.bleed-marks', { documentId: f.document.id, printAuthority: Object.create(null) }),
    { code: 'INVALID_PRODUCTION_AUTHORITY' },
  );
});

test('post-promotion cancellation and cleanup failures remain explicit', async (t) => {
  const f = await fixture(); cleanup(t, f);
  const aborted = AbortSignal.abort();
  await assert.rejects(
    () => f.professional.deliver('print.bleed-marks', { documentId: f.document.id, sourceSha256: f.document.sha256, bleedPoints: 9, markPages: [1], signal: aborted }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
  assert.throws(() => preflightFixups({ sourcePdf: Buffer.from('%PDF') }), { code: 'INVALID_PROFESSIONAL_INPUT' });
});
