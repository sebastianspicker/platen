import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { createOcrEvidenceExporter } from '../src/controllers/ocr-evidence-exporter.js';
import { createOcrWorkflowController } from '../src/controllers/ocr-workflow-controller.js';
import { createOcrZoneController } from '../src/controllers/ocr-zone-controller.js';
import { MAX_BROWSER_VERIFIED_OCR_BYTES } from '../src/controllers/ocr-workflow/ocr-artifact-verification.js';
import { createAppState } from '../src/core/app-state.js';
import { createApplicationInputHandler } from '../src/ui/application-form-input-handler.js';
import { canonicalOcrSuspectReviewJson } from '../src/core/ocr-suspect-review-contract.js';

test('OCR zone controller owns bounded non-overlapping page regions', () => {
  const state = { selectedPage: 1, ocrZones: [], selectedOcrZoneId: null };
  let resets = 0;
  const zones = createOcrZoneController({ state, clearSelection: () => { resets += 1; } });
  zones.newOcrZone();
  assert.equal(state.ocrZones[0].id, 'zone-1');
  assert.equal(state.selectedOcrZoneId, 'zone-1');
  zones.updateSelectedOcrZone('type', 'table');
  assert.equal(state.ocrZones[0].type, 'table');
  assert.equal(zones.normalizedCurrentPageOcrZones().length, 1);

  state.ocrZones.push({ ...state.ocrZones[0], id: 'zone-2' });
  assert.throws(() => zones.normalizedCurrentPageOcrZones(), /must not overlap/u);
  state.ocrZones.pop();
  zones.removeSelectedOcrZone();
  assert.deepEqual(state.ocrZones, []);
  assert.ok(resets >= 3);
});

test('OCR dictionary textarea clears stale searchable OCR state', () => {
  const state = createAppState();
  state.ocrResult = { old: true };
  state.ocrSuspectReviewStates = ['confirmed-low-confidence'];
  const handleInput = createApplicationInputHandler({
    state, ocr: {}, viewer: {}, documentApi: {}, render: () => {},
  });
  handleInput({ target: { value: 'alpha\nbeta', matches: (selector) => selector === '#ocr-user-dictionary' } });
  assert.equal(state.ocrUserDictionary, 'alpha\nbeta');
  assert.equal(state.ocrResult, null);
  assert.deepEqual(state.ocrSuspectReviewStates, []);
});

test('OCR evidence exporter verifies ALTO bytes before publishing them', async () => {
  const downloads = [];
  const errors = [];
  const state = {
    document: { name: 'scan.pdf' },
    selectedOcrRecordIndex: 0,
    selectedOcrTableCandidate: null,
    ocrLayoutResult: { records: [] },
  };
  const exporter = createOcrEvidenceExporter({
    state,
    triggerDownload: (download) => downloads.push(download),
    showError: (error) => errors.push(error.message),
    decodeBase64: atob,
    cryptoApi: webcrypto,
  });
  const bytes = Buffer.from('<alto/>');
  state.ocrLayoutResult.records = [{
    page: 1,
    zoneId: 'full',
    alto: {
      mediaType: 'application/alto+xml',
      encoding: 'base64',
      data: bytes.toString('base64'),
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  }];
  await exporter.exportOcrLayout('alto');
  assert.equal(downloads[0].fileName, 'scan-page-1-full.alto.xml');
  assert.equal(await downloads[0].blob.text(), '<alto/>');

  state.ocrLayoutResult.records[0].alto.sha256 = '0'.repeat(64);
  await exporter.exportOcrLayout('alto');
  assert.match(errors.at(-1), /digest does not match/u);
});

test('OCR workflow controller stages valid local files and downloads a searchable copy', async () => {
  const state = createAppState({
    documentSnapshot: { isOpen: true, name: 'scan.pdf' },
    snapshotClipboardReady: false,
  });
  state.analysis.documentId = 'document-1';
  state.analysis.sha256 = 'a'.repeat(64);
  state.ocrLanguages = ['eng'];
  state.ocrLanguage = 'eng';
  const downloads = [];
  const errors = [];
  const operation = { documentId: 'document-1', controller: new AbortController() };
  const suspect = {
    page: 1, text: 'w0rd', confidence: 42, left: 12, top: 24, width: 30, height: 14,
  };
  let current = true;
  let changeDecisionDuringCurrentCheck = false;
  let ocrDocumentCalls = 0;
  let artifactBytes = 'pdf';
  let artifactSize = 3;
  let responseSourceDigest = 'a'.repeat(64);
  let receivedOcrOptions = null;
  const deletedArtifacts = [];
  const artifactSha256 = createHash('sha256').update('pdf').digest('hex');
  const controller = createOcrWorkflowController({
    state,
    client: {
      async ocrDocument(_documentId, options) {
        ocrDocumentCalls += 1;
        receivedOcrOptions = options;
        return {
          sourceDigest: responseSourceDigest,
          artifact: {
            id: 'artifact-1', documentId: 'document-1', size: artifactSize,
            sha256: artifactSha256, displayName: 'scan-searchable.pdf',
          },
          result: {
            language: 'eng', cleanupPreset: 'document', segmentation: 'auto', pageCount: 1,
            recognizedWordCount: 1, suspects: [suspect],
          },
        };
      },
      async artifact() { return new Blob([artifactBytes], { type: 'application/pdf' }); },
      async deleteArtifact(id) { deletedArtifacts.push(id); },
    },
    getDocumentOperations: () => ({ activeController: null }),
    captureOperation: () => operation,
    operationIsCurrent: () => {
      if (changeDecisionDuringCurrentCheck) state.ocrSuspectReviewStates[0] = 'false-positive';
      return current;
    },
    reportOperationError: (error) => errors.push(error.message),
    finishOperation: () => { state.busyAction = null; },
    removeHostDocument: async () => {},
    triggerDownload: (download) => downloads.push(download),
    render: () => {},
    announce: () => {},
    showError: (error) => errors.push(error.message),
    cryptoApi: webcrypto,
  });
  assert.equal(controller.setOcrBatchFiles([{ name: 'batch.pdf', type: 'application/pdf' }]), true);
  assert.equal(state.ocrBatchFiles.length, 1);
  assert.equal(controller.setOcrBatchFiles([{ name: 'bad.exe', type: 'application/octet-stream' }]), false);
  assert.match(errors.at(-1), /PDF files/u);

  state.ocrUserDictionary = '  caf\u00e9  \nand/or\n';
  await controller.createSearchableOcrCopy();
  assert.deepEqual(receivedOcrOptions.userDictionary, ['  caf\u00e9  ', 'and/or']);
  assert.equal(downloads[0].fileName, 'scan-searchable.pdf');
  assert.deepEqual(state.ocrResult, {
    language: 'eng', cleanupPreset: 'document', segmentation: 'auto', pageCount: 1,
    recognizedWordCount: 1, suspects: [suspect], sourceDigest: 'a'.repeat(64),
    artifact: { id: 'artifact-1', sha256: artifactSha256 },
  });
  assert.deepEqual(state.ocrSuspectReviewStates, ['unreviewed']);
  assert.equal(controller.setOcrSuspectReviewState(0, 'confirmed-low-confidence'), true);
  assert.equal(controller.setOcrSuspectReviewState(1, 'false-positive'), false);
  await controller.exportOcrSuspectReview();
  assert.equal(ocrDocumentCalls, 1);
  assert.equal(downloads[1].fileName, 'scan-ocr-suspect-review.json');
  const downloadedReport = await downloads[1].blob.text();
  const report = JSON.parse(downloadedReport);
  assert.equal(downloadedReport, canonicalOcrSuspectReviewJson(report));
  assert.ok(downloads[1].blob.size <= 4 * 1024 * 1024);
  assert.equal(report.entries[0].reviewState, 'confirmed-low-confidence');
  assert.equal(report.claims.pdfBytesChanged, false);
  assert.match(report.reportSha256, /^[a-f0-9]{64}$/u);

  current = false;
  await controller.exportOcrSuspectReview();
  assert.equal(downloads.length, 2, 'stale local operations must not publish a report');

  current = true;
  changeDecisionDuringCurrentCheck = true;
  await controller.exportOcrSuspectReview();
  assert.equal(downloads.length, 2, 'changed review decisions must not publish a stale report');

  changeDecisionDuringCurrentCheck = false;
  artifactBytes = 'bad';
  await controller.createSearchableOcrCopy();
  assert.equal(downloads.length, 2, 'digest-mismatched OCR bytes must not be downloaded');
  assert.equal(state.ocrResult, null, 'a failed rerun must not retain the prior OCR result');
  assert.deepEqual(state.ocrSuspectReviewStates, []);
  assert.match(errors.at(-1), /digest does not match/u);

  artifactBytes = 'pdf';
  responseSourceDigest = 'f'.repeat(64);
  await controller.createSearchableOcrCopy();
  assert.equal(downloads.length, 2, 'foreign-source OCR metadata must not fetch or publish bytes');
  assert.equal(state.ocrResult, null);
  assert.match(errors.at(-1), /not bound to the current source/u);

  responseSourceDigest = 'a'.repeat(64);
  artifactSize = MAX_BROWSER_VERIFIED_OCR_BYTES + 1;
  await controller.createSearchableOcrCopy();
  assert.deepEqual(deletedArtifacts, ['artifact-1']);
  assert.equal(downloads.length, 2, 'oversized OCR bytes must not be retrieved or published');
  assert.match(errors.at(-1), /limited to 64 MiB/u);
});

function clipboardScreenshotFixture() {
  const state = createAppState({
    documentSnapshot: { isOpen: true, name: 'screenshot-source.pdf', size: 2048, type: 'application/pdf', objectUrl: 'blob:source' },
    snapshotClipboardReady: false,
  });
  state.analysis.documentId = 'document-9';
  state.analysis.sha256 = 'a'.repeat(64);
  state.ocrLanguages = ['eng'];
  state.ocrLanguage = 'eng';
  const downloads = [];
  const errors = [];
  const screenshotClipboardPng = new Blob(['image'], { type: 'image/png' });
  const clipboardItems = [{
    types: ['image/png'],
    getType: async () => screenshotClipboardPng,
  }];
  const navigatorApi = { clipboard: { read: async () => clipboardItems } };
  const deletedArtifacts = [];
  const deletedInputs = [];
  const deletedHostDocuments = [];
  let failDeleteInput = false;
  const temporaryDocument = {
    id: 'tmp-clipboard-doc',
    sha256: 'b'.repeat(64),
    operation: { validation: { pageCount: 1 } },
  };
  const screenshotArtifact = {
    id: 'artifact-clipboard-1',
    documentId: temporaryDocument.id,
    size: 3,
    sha256: createHash('sha256').update('pdf').digest('hex'),
    displayName: 'screenshot-searchable-ocr.pdf',
  };
  const received = {
    uploadCalls: 0,
    ocrCalls: 0,
    convertCalls: 0,
    ocrArtifactCalls: 0,
    ocrOptions: null,
  };
  let responseSourceDigest = temporaryDocument.sha256;

  const controller = createOcrWorkflowController({
    state,
    client: {
      async uploadInput(file) {
        assert.equal(file.type, 'image/png');
        received.uploadCalls += 1;
        return { id: 'clipboard-input-1', sha256: createHash('sha256').update('image').digest('hex'), displayName: 'clipboard.png' };
      },
      async convertInput(inputId) {
        assert.equal(inputId, 'clipboard-input-1');
        received.convertCalls += 1;
        return temporaryDocument;
      },
      async ocrDocument(documentId, options) {
        received.ocrCalls += 1;
        received.ocrOptions = options;
        return {
          sourceDigest: responseSourceDigest,
          artifact: screenshotArtifact,
          result: {
            language: 'eng', cleanupPreset: 'document', segmentation: 'auto', pageCount: 1,
            recognizedWordCount: 1, suspects: [{
              page: 1, text: 'sample', confidence: 95, left: 1, top: 2, width: 3, height: 4,
            }],
          },
        };
      },
      async artifact() {
        received.ocrArtifactCalls += 1;
        return new Blob(['pdf'], { type: 'application/pdf' });
      },
      async deleteArtifact(id) {
        deletedArtifacts.push(id);
      },
      async deleteInput(id) {
        deletedInputs.push(id);
        if (failDeleteInput) {
          throw new Error('clipboard cleanup input deletion failed');
        }
      },
    },
    getDocumentOperations: () => ({ activeController: null }),
    captureOperation: () => ({ documentId: state.analysis.documentId, controller: new AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: (error) => errors.push(error.message),
    finishOperation: () => { state.busyAction = null; },
    removeHostDocument: async (documentId) => {
      deletedHostDocuments.push(documentId);
    },
    triggerDownload: (download) => downloads.push(download),
    render: () => {},
    announce: () => {},
    showError: (error) => errors.push(error.message),
    cryptoApi: webcrypto,
    navigatorApi,
    FileCtor: class MockFile extends Blob {
      constructor(parts, name, options) {
        super(parts, options);
        this.name = name;
      }
    },
  });

  return {
    state, controller, downloads, errors, received, deletedArtifacts, deletedInputs,
    deletedHostDocuments, navigatorApi,
    setFailDeleteInput(value) { failDeleteInput = value; },
    setResponseSourceDigest(value) { responseSourceDigest = value; },
  };
}

test('OCR workflow controller performs clipboard screenshot OCR with temporary source cleanup', async () => {
  const fixture = clipboardScreenshotFixture();
  const {
    controller, downloads, errors, received, deletedArtifacts, deletedInputs,
    deletedHostDocuments, navigatorApi,
  } = fixture;
  await controller.createClipboardScreenshotOcr();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].fileName, 'screenshot-source-clipboard-screenshot-searchable-ocr.pdf');
  assert.equal(received.uploadCalls, 1);
  assert.equal(received.convertCalls, 1);
  assert.equal(received.ocrCalls, 1);
  assert.equal(received.ocrArtifactCalls, 1);
  assert.deepEqual(received.ocrOptions, {
    language: 'eng',
    cleanupPreset: 'document',
    segmentation: 'auto',
    userDictionary: [],
  });
  assert.deepEqual(deletedArtifacts, ['artifact-clipboard-1']);
  assert.deepEqual(deletedInputs, ['clipboard-input-1']);
  assert.deepEqual(deletedHostDocuments, ['tmp-clipboard-doc']);
  assert.equal(downloads.length, 1);

  fixture.setFailDeleteInput(true);
  await controller.createClipboardScreenshotOcr();
  assert.equal(downloads.length, 1, 'cleanup failure should suppress screenshot OCR download');
  assert.match(errors.at(-1), /cleanup input deletion failed/u);
  assert.deepEqual(deletedArtifacts, ['artifact-clipboard-1', 'artifact-clipboard-1']);
  assert.deepEqual(deletedInputs, ['clipboard-input-1', 'clipboard-input-1']);
  assert.deepEqual(deletedHostDocuments, ['tmp-clipboard-doc', 'tmp-clipboard-doc']);
  fixture.setFailDeleteInput(false);

  fixture.setResponseSourceDigest('c'.repeat(64));
  await controller.createClipboardScreenshotOcr();
  assert.match(errors.at(-1), /not bound to the temporary conversion output/);

  navigatorApi.clipboard.read = async () => [{
    types: ['text/plain'],
    getType: async () => new Blob(['not-png']),
  }];
  await controller.createClipboardScreenshotOcr();
  assert.match(errors.at(-1), /exactly one PNG representation/);
});
