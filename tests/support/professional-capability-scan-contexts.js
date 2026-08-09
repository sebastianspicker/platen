import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlankPdf } from '../../scripts/host/pdf-factory.mjs';
import { createOperationProvenance } from '../../scripts/host/operation-provenance.mjs';
import { PDF_COPY_PAGE_PROFILE, PDF_COPY_PAGE_VALIDATORS } from '../../scripts/host/pdf-copy-page-contract.mjs';
import { SCANNER_DUPLEX_PROFILE } from '../../scripts/host/scanner-duplex-contract.mjs';

function makeOperationFixtureError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = code === 'INVALID_SCANNER_DUPLEX_OPTIONS' || code === 'INVALID_COPY_PAGE_REQUEST' ? 400 : 502;
  return error;
}

function parsePageCountPdf(pdf) {
  const match = pdf.toString('latin1').match(/\/Count\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

function createAppendState() {
  const root = mkdtempSync(join(tmpdir(), 'platen-scan-append-'));
  const primaryDocumentId = '00000000-0000-4000-8000-000000000000';
  const scannedDocumentId = '00000000-0000-4000-8000-000000000001';
  const artifactId = '00000000-0000-4000-8000-000000000002';
  const basePdf = createBlankPdf({ pages: 1, title: 'scan-append-base' });
  const scannedPdf = createBlankPdf({ pages: 1, title: 'scan-append-scan' });
  const basePath = join(root, 'base.pdf');
  const scannedPath = join(root, 'scan.pdf');
  writeFileSync(basePath, basePdf, { mode: 0o600 });
  writeFileSync(scannedPath, scannedPdf, { mode: 0o600 });
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const records = new Map([
    [primaryDocumentId, { id: primaryDocumentId, documentId: primaryDocumentId, mediaType: 'application/pdf', size: basePdf.length, sha256: digest(basePdf), filePath: basePath, pageCount: parsePageCountPdf(basePdf) }],
    [scannedDocumentId, { id: scannedDocumentId, documentId: scannedDocumentId, mediaType: 'application/pdf', size: scannedPdf.length, sha256: digest(scannedPdf), filePath: scannedPath, pageCount: parsePageCountPdf(scannedPdf) }],
  ]);
  return { root, primaryDocumentId, scannedDocumentId, artifactId, basePdf, scannedPdf, records, digest, artifact: null };
}

function createAppendStore(state) {
  return {
    getDocument(documentId) {
      const record = state.records.get(documentId);
      if (!record) {
        const error = new Error('source document missing');
        error.code = 'DOCUMENT_NOT_FOUND';
        throw error;
      }
      return { id: record.id, documentId: record.documentId, mediaType: record.mediaType, size: record.size, sha256: record.sha256 };
    },
    getArtifact(documentId) {
      if (!state.artifact || state.artifact.id !== documentId) {
        const error = new Error('artifact missing');
        error.code = 'ARTIFACT_NOT_FOUND';
        throw error;
      }
      return { ...state.artifact, operation: state.artifact.operation, filePath: state.artifact.filePath };
    },
    getSourcePath(documentId) {
      const record = state.records.get(documentId);
      if (!record) {
        const error = new Error('source path missing');
        error.code = 'SOURCE_MISSING';
        throw error;
      }
      return record.filePath;
    },
    verifySource(documentId) {
      const record = state.records.get(documentId);
      if (!record) {
        const error = new Error('source document missing');
        error.code = 'DOCUMENT_NOT_FOUND';
        throw error;
      }
      const bytes = readFileSync(record.filePath);
      if (record.sha256 !== state.digest(bytes) || bytes.length !== record.size) {
        const error = new Error('source document drifted');
        error.code = 'SOURCE_INTEGRITY_FAILED';
        throw error;
      }
      return true;
    },
  };
}

function createAppendService(state) {
  return {
    async copyPageBetweenDocuments(requestPrimaryId, requestSecondaryId, request) {
      const primary = state.records.get(state.primaryDocumentId);
      const secondary = state.records.get(state.scannedDocumentId);
      if (requestPrimaryId !== state.primaryDocumentId || requestSecondaryId !== state.scannedDocumentId) {
        throw makeOperationFixtureError('INVALID_COPY_PAGE_REQUEST', 'copy-page received invalid source bindings.');
      }
      if (!request || request.profile !== PDF_COPY_PAGE_PROFILE
        || request.primarySourceSha256 !== primary.sha256 || request.secondarySourceSha256 !== secondary.sha256
        || !Number.isSafeInteger(request.sourcePage) || request.sourcePage < 1 || request.sourcePage > secondary.pageCount
        || !Number.isSafeInteger(request.afterPage) || request.afterPage < 0 || request.afterPage > primary.pageCount) {
        throw makeOperationFixtureError('INVALID_COPY_PAGE_REQUEST', 'copy-page request was invalid.');
      }
      const selections = [];
      for (let page = 1; page <= request.afterPage; page += 1) selections.push({ input: 0, page });
      selections.push({ input: 1, page: request.sourcePage });
      for (let page = request.afterPage + 1; page <= primary.pageCount; page += 1) selections.push({ input: 0, page });
      const output = createBlankPdf({ pages: selections.length, title: 'scan-append-output' });
      const outputSha256 = state.digest(output);
      const manifestSha256 = state.digest(`scan-append-manifest-v1\0${outputSha256}`);
      const outputPath = join(state.root, 'scan-append-output.pdf');
      writeFileSync(outputPath, output, { mode: 0o600 });
      const operation = createOperationProvenance({
        type: 'copy-page-between-documents',
        inputs: [
          { documentId: state.primaryDocumentId, sha256: primary.sha256, role: 'primary' },
          { documentId: state.scannedDocumentId, sha256: secondary.sha256, role: 'secondary' },
        ],
        parameters: { profile: request.profile, sourcePage: request.sourcePage, afterPage: request.afterPage, selections },
        expected: { pageCount: selections.length, manifestSha256 },
        validation: { passed: true, validators: PDF_COPY_PAGE_VALIDATORS, pageCount: selections.length, manifestSha256 },
      });
      state.artifact = { id: state.artifactId, documentId: state.primaryDocumentId, mediaType: 'application/pdf', size: output.length, sha256: outputSha256, filePath: outputPath, operation, createdAt: '2026-07-27T00:00:00.000Z' };
      state.records.set(state.artifactId, { ...state.artifact, pageCount: selections.length });
      return { id: state.artifact.id, documentId: state.artifact.documentId, mediaType: state.artifact.mediaType, size: state.artifact.size, sha256: state.artifact.sha256, filePath: state.artifact.filePath, operation };
    },
  };
}

export function scanAppendContext() {
  const state = createAppendState();
  return {
    documentId: state.primaryDocumentId,
    scanDocumentId: state.scannedDocumentId,
    sourcePdf: state.basePdf,
    scanSourcePdf: state.scannedPdf,
    sourceBytes: state.basePdf,
    baseSha256: state.records.get(state.primaryDocumentId).sha256,
    scanSha256: state.records.get(state.scannedDocumentId).sha256,
    service: createAppendService(state),
    store: createAppendStore(state),
    cleanup() { rmSync(state.root, { recursive: true, force: true }); },
  };
}

function createDuplexState() {
  const root = mkdtempSync(join(tmpdir(), 'platen-scan-duplex-'));
  return { root, documentId: '00000000-0000-4000-8000-000000000003', artifactPath: join(root, 'duplex-scan.pdf'), artifact: null };
}

function createDuplexStore(state) {
  return {
    getDocument(id) {
      if (!state.artifact || state.artifact.id !== id) {
        const error = new Error('artifact missing');
        error.code = 'ARTIFACT_NOT_FOUND';
        throw error;
      }
      return { ...state.artifact, operation: state.artifact.operation, filePath: state.artifact.filePath };
    },
    verifySource(id) {
      if (!state.artifact || state.artifact.id !== id) {
        const error = new Error('artifact source missing');
        error.code = 'SOURCE_MISSING';
        throw error;
      }
      const bytes = readFileSync(state.artifact.filePath);
      if (bytes.length !== state.artifact.size || createHash('sha256').update(bytes).digest('hex') !== state.artifact.sha256) {
        const error = new Error('artifact source drifted');
        error.code = 'SOURCE_INTEGRITY_FAILED';
        throw error;
      }
      return true;
    },
    getSourcePath() { return state.artifactPath; },
  };
}

function createDuplexService(state) {
  const requiredValidationKeys = ['pinned-helper-sha256', 'persistent-scanner-identity', 'advertised-duplex-feeder', 'private-workspace', 'scanner-output-digest', 'independent-pdf-structure', 'exact-page-count-reinspection'];
  return {
    async acquire(request) {
      if (!request || request.profile !== SCANNER_DUPLEX_PROFILE || request.source !== 'feeder' || request.duplex !== true || request.format !== 'PDF') {
        throw makeOperationFixtureError('INVALID_SCANNER_DUPLEX_OPTIONS', 'scan duplex feeder request invalid.');
      }
      const pageCount = request.pageCount;
      if (!Number.isSafeInteger(pageCount) || pageCount < 2 || pageCount > 50 || (pageCount % 2) !== 0) {
        throw makeOperationFixtureError('INVALID_SCANNER_DUPLEX_OPTIONS', 'scan duplex page-count invalid.');
      }
      const output = createBlankPdf({ pages: pageCount, title: 'scan-duplex-output' });
      const outputSha256 = createHash('sha256').update(output).digest('hex');
      const pages = Array.from({ length: pageCount }, (_, index) => ({ sequence: index + 1, sheet: Math.ceil((index + 1) / 2), side: index % 2 === 0 ? 'front' : 'back' }));
      writeFileSync(state.artifactPath, output, { mode: 0o600 });
      const operation = createOperationProvenance({
        type: 'scan-duplex-feeder', inputs: [],
        parameters: { profile: request.profile, deviceId: request.deviceId, source: request.source, duplex: request.duplex, color: request.color, dpi: request.dpi, pageCount, maxPixels: request.maxPixels, format: request.format },
        expected: { pageCount, outputSha256, sourceFree: true },
        validation: { passed: true, validators: requiredValidationKeys, outputSha256 },
      });
      state.artifact = { id: state.documentId, documentId: state.documentId, mediaType: 'application/pdf', size: output.length, sha256: outputSha256, filePath: state.artifactPath, operation, createdAt: '2026-07-27T00:00:00.000Z' };
      return {
        kind: 'scan-duplex-feeder', document: { id: state.artifact.id, mediaType: state.artifact.mediaType, size: state.artifact.size, sha256: state.artifact.sha256 },
        helperReport: { authority: 'unvalidated-helper-page-report-v1', pages }, operation,
        evidence: { api: 'ImageCaptureCore', discoveryAttempted: true, liveVerification: true, scanSupport: 'duplex-feeder-supported', persistentIdentityVerified: true, feederSupportAdvertised: true, sourceFree: true, helperVerified: true, outputDigestBound: true, pdfStructureReinspected: true, helperPageMetadataValidated: false, localOnly: true },
      };
    },
  };
}

export function scanDuplexContext() {
  const state = createDuplexState();
  return { service: createDuplexService(state), store: createDuplexStore(state), cleanup() { rmSync(state.root, { recursive: true, force: true }); } };
}
