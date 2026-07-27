import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../scripts/host/host-error.mjs';
import {
  MAX_OUTLINE_SPLIT_OUTPUT_BYTES,
  PdfKitOutlineSplitService,
} from '../scripts/host/pdfkit-outline-split-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const digest = 'a'.repeat(64);

function fixture({
  pageCount = 6,
  outline = { items: [{ title: 'Private start', page: 1, children: [] }, { title: 'Secret middle', page: 3, children: [] }, { title: 'Confidential end', page: 5, children: [] }], truncated: false },
  inspectionDigest = digest,
  artifactSize = 1_024,
  failAt = null,
  afterExtract = null,
  afterVerify = null,
} = {}) {
  const calls = []; const deleted = []; let verifies = 0;
  const store = {
    getDocument: () => ({ id: documentId, sha256: digest }),
    verifySource: async () => { verifies += 1; afterVerify?.(verifies); },
    deleteArtifact: async (id) => { deleted.push(id); },
  };
  const pdfService = {
    extractPages: async (_documentId, pages, options) => {
      calls.push({ pages, options });
      if (calls.length === failAt) throw new HostError('ENGINE_FAILED', 'fixture failure', 502);
      afterExtract?.(calls.length);
      return {
        id: `artifact-${calls.length}`, size: artifactSize,
        displayName: options.fileLabel, operation: { parameters: options.parameters },
      };
    },
  };
  const pdfkitInspectionService = {
    inspect: async () => ({ sourceDigest: inspectionDigest, pageCount, document: { pageCount }, outline }),
  };
  return {
    service: new PdfKitOutlineSplitService({ store, pdfService, pdfkitInspectionService }),
    calls,
    state: () => ({ verifies, deleted }),
  };
}

test('PDFKit top-level outline split derives contiguous ranges with title-free numeric provenance', async () => {
  const { service, calls, state } = fixture();
  const artifacts = await service.split(documentId);
  assert.deepEqual(calls.map(({ pages }) => pages), [[1, 2], [3, 4], [5, 6]]);
  assert.equal(artifacts.length, 3);
  assert.deepEqual(calls.map(({ options }) => options.parameters.splitRule), [
    { kind: 'top-level-outline', profile: 'macos-pdfkit-top-level-outline-split-v1', outputIndex: 1, outputCount: 3, firstPage: 1, lastPage: 2 },
    { kind: 'top-level-outline', profile: 'macos-pdfkit-top-level-outline-split-v1', outputIndex: 2, outputCount: 3, firstPage: 3, lastPage: 4 },
    { kind: 'top-level-outline', profile: 'macos-pdfkit-top-level-outline-split-v1', outputIndex: 3, outputCount: 3, firstPage: 5, lastPage: 6 },
  ]);
  assert.match(JSON.stringify({ artifacts, calls }), /outline-001-pages-1-2/);
  assert.doesNotMatch(JSON.stringify({ artifacts, calls }), /Private start|Secret middle|Confidential end/);
  assert.equal(state().verifies, 1);
  assert.deepEqual(state().deleted, []);
});

test('PDFKit top-level outline split rejects unsupported roots and source mismatches', async () => {
  const unsupportedOutlines = [
    { items: [], truncated: false },
    { items: [{ title: 'First', page: 1 }, { title: 'Second', page: 3 }], truncated: true },
    { items: [{ title: null, page: 1 }, { title: 'Second', page: 3 }], truncated: false },
    { items: [{ title: '', page: 1 }, { title: 'Second', page: 3 }], truncated: false },
    { items: [{ title: 'First', page: 1 }, { title: 'Second', page: null }], truncated: false },
    { items: [{ title: 'First', page: 1 }, { title: 'Second', page: 7 }], truncated: false },
    { items: [{ title: 'First', page: 1 }, { title: 'Second', page: 1 }], truncated: false },
    { items: [{ title: 'First', page: 3 }, { title: 'Second', page: 1 }], truncated: false },
    { items: [{ title: 'First', page: 2 }, { title: 'Second', page: 3 }], truncated: false },
  ];
  for (const outline of unsupportedOutlines) {
    await assert.rejects(fixture({ outline }).service.split(documentId), { code: 'OUTLINE_SPLIT_UNSUPPORTED', status: 422 });
  }
  await assert.rejects(fixture({ pageCount: 1 }).service.split(documentId), { code: 'OUTLINE_SPLIT_UNSUPPORTED' });
  await assert.rejects(fixture({ inspectionDigest: 'b'.repeat(64) }).service.split(documentId), { code: 'OUTLINE_SPLIT_UNSUPPORTED' });
});

test('PDFKit top-level outline split rolls back partial artifacts on failure', async () => {
  const setup = fixture({ failAt: 2 });
  await assert.rejects(setup.service.split(documentId), { code: 'ENGINE_FAILED' });
  assert.deepEqual(setup.state().deleted, ['artifact-1']);
});

test('PDFKit top-level outline split removes a promoted output with invalid accounting metadata', async () => {
  const setup = fixture({ artifactSize: null });
  await assert.rejects(setup.service.split(documentId), { code: 'OUTLINE_SPLIT_ARTIFACT_INVALID' });
  assert.deepEqual(setup.state().deleted, ['artifact-1']);
});

test('PDFKit top-level outline split rolls back when aggregate output exceeds its fixed quota', async () => {
  const setup = fixture({ artifactSize: Math.floor(MAX_OUTLINE_SPLIT_OUTPUT_BYTES / 2) + 1 });
  await assert.rejects(setup.service.split(documentId), { code: 'OUTLINE_SPLIT_OUTPUT_LIMIT', status: 413 });
  assert.deepEqual(setup.state().deleted, ['artifact-1', 'artifact-2']);
});

test('PDFKit top-level outline split rolls back after mid-loop cancellation', async () => {
  const controller = new AbortController();
  const setup = fixture({ afterExtract: (count) => { if (count === 1) controller.abort(); } });
  await assert.rejects(setup.service.split(documentId, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.deepEqual(setup.state().deleted, ['artifact-1']);
});

test('PDFKit top-level outline split rolls back when cancellation lands during the final source check', async () => {
  const controller = new AbortController();
  const setup = fixture({ afterVerify: () => controller.abort() });
  await assert.rejects(setup.service.split(documentId, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.deepEqual(setup.state().deleted, ['artifact-1', 'artifact-2', 'artifact-3']);
});
