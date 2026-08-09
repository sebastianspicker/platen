import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { deliverProfessionalCapability } from '../scripts/host/professional-capability/index.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { PdfInspectionService } from '../scripts/host/pdf-inspection-service.mjs';
import { PdfCompositionService } from '../scripts/host/pdf-composition-service.mjs';
import { ScannerDuplexFeederService } from '../scripts/host/scanner-duplex-service.mjs';
import {
  SCANNER_DUPLEX_PROFILE,
  SCANNER_DUPLEX_MAX_BYTES,
  SCANNER_DUPLEX_MAX_DEADLINE_MS,
} from '../scripts/host/scanner-duplex-contract.mjs';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import { contextFor } from './support/professional-capability-delivery-support.js';

function countPageObjects(pdf) {
  const pages = pdf.toString('latin1');
  return (pages.match(/\/Type \/Page(?!s)/g) ?? []).length;
}

test('scan append capability reports stable composition and source digests', async (context) => {
  const fixture = contextFor('scan.append-to-document');
  context.after(fixture.cleanup);
  const base = fixture.sourcePdf;
  const outcome = await deliverProfessionalCapability('scan.append-to-document', fixture);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.method, 'local-scan-append-pages');
  assert.equal(outcome.pageCount, 2);
  assert.equal(outcome.structuralPageCount, 2);
  assert.equal(outcome.appendedPages, 1);
  assert.equal(outcome.baseSha256, createHash('sha256').update(base).digest('hex'));
  assert.equal(outcome.scannedSha256, fixture.scanSha256);
  assert.equal(outcome.sourcePageCount, 1);
  assert.equal(outcome.scannedPageCount, 1);
  assert.equal(outcome.operation.type, 'copy-page-between-documents');
  assert.equal(outcome.operation.parameters.profile, 'local-copy-one-page-between-documents-v1');
  assert.equal(outcome.operation.expected.pageCount, 2);
  assert.equal(outcome.operation.validation.manifestSha256, outcome.operation.expected.manifestSha256);
  assert.equal(outcome.operation.parameters.selections.length, 2);
  assert.equal(countPageObjects(outcome.pdf), 2);
  assert.match(outcome.pdf.toString('latin1'), /\/Count 2/);
  assert.equal(outcome.outputSha256, createHash('sha256').update(outcome.pdf).digest('hex'));
  assert.equal(outcome.outputSha256, outcome.outputDigest);
  assert.ok(Array.isArray(outcome.operation.validation.validators) && outcome.operation.validation.validators.includes('source-sha256'));
});

test('scan append capability fails closed on undersized source bytes', async (context) => {
  const fixture = contextFor('scan.append-to-document');
  context.after(fixture.cleanup);
  await assert.rejects(
    () => deliverProfessionalCapability('scan.append-to-document', { ...fixture, sourcePdf: Buffer.from('abc') }),
    { code: 'INVALID_PROFESSIONAL_INPUT', status: 400 },
  );
});

test('scan duplex feeder captures exact front/back order and duplex evidence', async (context) => {
  const fixture = contextFor('scan.duplex-feeder');
  context.after(fixture.cleanup);
  const outcome = await deliverProfessionalCapability('scan.duplex-feeder', { ...fixture, sheets: 2, sides: 'duplex' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.method, 'local-scanner-duplex-feeder');
  assert.equal(outcome.sides, 'duplex');
  assert.equal(outcome.sheets, 2);
  assert.equal(outcome.pageCount, 4);
  assert.equal(outcome.structuralPageCount, 4);
  assert.equal(outcome.helperReport?.authority, 'unvalidated-helper-page-report-v1');
  assert.deepEqual(outcome.helperReport.pages.map((page) => ({
    sequence: page.sequence,
    sheet: page.sheet,
    side: page.side,
  })), [
    { sequence: 1, sheet: 1, side: 'front' },
    { sequence: 2, sheet: 1, side: 'back' },
    { sequence: 3, sheet: 2, side: 'front' },
    { sequence: 4, sheet: 2, side: 'back' },
  ]);
  assert.equal(outcome.operation.type, 'scan-duplex-feeder');
  assert.equal(outcome.operation.expected.sourceFree, true);
  assert.equal(outcome.operation.parameters.pageCount, 4);
  assert.equal(outcome.operation.expected.pageCount, 4);
  assert.ok(Array.isArray(outcome.operation.validation.validators) && outcome.operation.validation.validators.length >= 6);
  assert.equal(outcome.evidence.feederSupportAdvertised, true);
  assert.equal(outcome.evidence.sourceFree, true);
  assert.equal(outcome.evidence.helperVerified, true);
  assert.equal(outcome.evidence.outputDigestBound, true);
  assert.equal(outcome.evidence.pdfStructureReinspected, true);
  assert.equal(outcome.evidence.sourceFree, true);
  assert.match(outcome.pdf.toString('latin1'), /\/Count 4/);
  assert.equal(countPageObjects(outcome.pdf), 4);
  assert.equal(outcome.outputSha256, createHash('sha256').update(outcome.pdf).digest('hex'));
});

test('scan duplex feeder rejects invalid sides and impossible sheet counts', async (context) => {
  const fixture = contextFor('scan.duplex-feeder');
  context.after(fixture.cleanup);
  await assert.rejects(
    () => deliverProfessionalCapability('scan.duplex-feeder', { ...fixture, sides: 'simplex' }),
    { code: 'INVALID_DUPLEX_SIDES', status: 400 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('scan.duplex-feeder', { ...fixture, sheets: 0 }),
    { code: 'INVALID_SHEETS', status: 400 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('scan.duplex-feeder', { sheets: 1.5 }),
    { code: 'INVALID_SHEETS', status: 400 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('scan.duplex-feeder', { sides: 'simplex' }),
    { code: 'INVALID_DUPLEX_SIDES', status: 400 },
  );
});

test('scan duplex feeder fails closed when retained source bytes drift after the service receipt', async (context) => {
  const fixture = contextFor('scan.duplex-feeder');
  context.after(fixture.cleanup);
  const acquire = fixture.service.acquire;
  fixture.service.acquire = async (request) => {
    const receipt = await acquire(request);
    writeFileSync(fixture.store.getSourcePath(receipt.document.id), Buffer.from('drifted bytes'));
    return receipt;
  };
  await assert.rejects(
    () => deliverProfessionalCapability('scan.duplex-feeder', fixture),
    { code: 'SCAN_DUPLEX_DOCUMENT_NOT_FOUND', status: 502 },
  );
});

test('scan duplex feeder maps malformed service provenance to its capability boundary', async (context) => {
  const fixture = contextFor('scan.duplex-feeder');
  context.after(fixture.cleanup);
  const acquire = fixture.service.acquire;
  fixture.service.acquire = async (request) => ({ ...(await acquire(request)), operation: { malformed: true } });
  await assert.rejects(
    () => deliverProfessionalCapability('scan.duplex-feeder', fixture),
    { code: 'SCAN_DUPLEX_OPERATION_INVALID', status: 502 },
  );
});

async function popplerAvailable() {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext',
      '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdfseparate',
      '/opt/homebrew/bin/pdfunite', '/opt/homebrew/bin/pdfsig'].map((path) => access(path)));
    return true;
  } catch { return false; }
}

test('scanner append adapter uses real DocumentStore and composition receipts when Poppler is installed', async (t) => {
  if (!await popplerAvailable()) {
    t.skip('Poppler copy-page engines are not installed in the fixed engine search path.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-real-scan-append-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const registry = new EngineRegistry();
  const adapter = new PopplerAdapter({ registry });
  const inspection = new PdfInspectionService({ store, registry, adapter });
  const service = new PdfCompositionService({ store, adapter, inspection });
  const sourcePdf = createBlankPdf({ pages: 1, title: 'real-scan-base' });
  const scanSourcePdf = createBlankPdf({ pages: 1, title: 'real-scan-page' });
  const document = await store.createDocument({ stream: Readable.from([sourcePdf]), displayName: 'base.pdf' });
  const scanned = await store.createDocument({ stream: Readable.from([scanSourcePdf]), displayName: 'scan.pdf' });
  const outcome = await deliverProfessionalCapability('scan.append-to-document', {
    documentId: document.id, scanDocumentId: scanned.id, sourcePdf, scanSourcePdf, service, store,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.operation.type, 'copy-page-between-documents');
  assert.deepEqual(outcome.operation.parameters.selections.map(({ input, page }) => ({ input, page })), [{ input: 1, page: 1 }, { input: 0, page: 1 }]);
  assert.deepEqual(outcome.operation.validation.validators, [
    'source-sha256', 'private-source-copy', 'bounded-passive-graph-scan',
    'poppler-page-boxes-text-render-manifest',
  ]);
  assert.notEqual(outcome.operation.expected.manifestSha256, outcome.outputSha256);
  assert.equal(await store.verifySource(document.id), true);
  assert.equal(await store.verifySource(scanned.id), true);
});

test('scanner duplex adapter uses real DocumentStore and ScannerDuplexFeederService receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-real-scan-duplex-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const inspection = { inspect: async (id) => {
    assert.equal(store.getDocument(id).mediaType, 'application/pdf');
    return { pageCount: 4 };
  } };
  let requested;
  const service = new ScannerDuplexFeederService({
    job: {
      async run(request) {
        requested = request;
        const bytes = createBlankPdf({ pages: request.pageCount, title: 'real-scanner-job' });
        return {
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          request,
          helperReportedPages: Array.from({ length: request.pageCount }, (_, index) => ({
            sequence: index + 1, sheet: Math.ceil((index + 1) / 2), side: index % 2 === 0 ? 'front' : 'back',
          })),
          evidence: {
            api: 'ImageCaptureCore', discoveryAttempted: true, liveVerification: true,
            scanSupport: 'duplex-feeder-supported', persistentIdentityVerified: true,
            feederSupportAdvertised: true,
          },
        };
      },
    },
    store,
    inspection,
  });
  const outcome = await deliverProfessionalCapability('scan.duplex-feeder', { service, store, sheets: 2, sides: 'duplex' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.receipt.id, outcome.documentId);
  assert.equal(outcome.receipt.documentId, undefined);
  assert.equal(outcome.operation.parameters.profile, SCANNER_DUPLEX_PROFILE);
  assert.equal(requested.maxPixels, 4 * 2550 * 3300);
  assert.equal(requested.maxBytes, SCANNER_DUPLEX_MAX_BYTES);
  assert.equal(requested.deadlineMs, Math.min(60_000, SCANNER_DUPLEX_MAX_DEADLINE_MS));
  assert.equal(outcome.operation.expected.outputSha256, outcome.receipt.sha256);
  assert.equal(await store.verifySource(outcome.receipt.id), true);
});
