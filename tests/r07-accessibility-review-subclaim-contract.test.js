import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccessibilityReviewService,
  ACCESSIBILITY_REVIEW_PROFILE,
  ACCESSIBILITY_REVIEW_VERSION,
} from '../scripts/host/accessibility-review-service.mjs';
import { ACCESSIBILITY_REVIEW_LIMITATIONS } from '../scripts/host/accessibility-review-report.mjs';

const documentId = '123e4567-e89b-42d3-a456-426614174000';
const sourceDigest = 'a'.repeat(64);

function fixture() {
  let verifyCalls = 0;
  const calls = { structure: null, extract: 0 };
  const store = {
    getDocument(id) {
      assert.equal(id, documentId);
      return { id, sha256: sourceDigest, privatePath: '/private/source.pdf' };
    },
    async verifySource(id) {
      assert.equal(id, documentId);
      verifyCalls += 1;
      return true;
    },
  };
  const pdfService = {
    async inspect() {
      return { pageCount: 2, tagged: 'yes', title: 'R07 source', form: 'none' };
    },
    async inspectStructure(_id, options) {
      calls.structure = options;
      return {
        sourceDigest,
        pageRange: { first: 1, last: 2 },
        taggedStructure: {
          present: true,
          includesText: options.includeTagText,
          lines: [
            { depth: 0, value: 'Document' },
            { depth: 2, value: 'H1' },
            { depth: 2, value: 'H3' },
            { depth: 2, value: 'L' },
            { depth: 4, value: 'LI' },
            { depth: 6, value: 'LBody' },
            { depth: 2, value: 'Artifact' },
          ],
        },
        xmpMetadata: { xml: '<xmpmeta />' },
        customMetadata: [],
        urls: [],
        privatePath: '/private/structure.pdf',
      };
    },
    async listFonts() {
      return [
        { unicode: 'no', embedded: 'yes' },
        { unicode: 'yes', embedded: 'no' },
      ];
    },
    async listImages() {
      return [{ page: 1, number: 0, objectId: 8, generation: 0, width: 100, height: 200, rawImagePayload: 'SECRET-IMAGE' }];
    },
    async extractText(_id, count) {
      calls.extract += 1;
      return Array.from({ length: count }, (_value, page) => ({ page: page + 1, text: 'SECRET-EXTRACTED-TEXT' }));
    },
  };
  return {
    service: new AccessibilityReviewService({ store, pdfService }),
    calls,
    get verifyCalls() { return verifyCalls; },
  };
}

test('R07 accessibility subclaims use fixed source-bound evidence without semantic overclaim', async () => {
  const value = fixture();
  const report = await value.service.review(documentId);
  const byId = new Map(report.checks.map((entry) => [entry.id, entry]));

  assert.deepEqual(report.profile, {
    id: ACCESSIBILITY_REVIEW_PROFILE,
    title: 'Basic local accessibility review',
    version: ACCESSIBILITY_REVIEW_VERSION,
  });
  assert.equal(report.sourceDigest, sourceDigest);
  assert.equal(report.pageCount, 2);
  assert.equal(value.verifyCalls, 2);
  assert.equal(value.calls.structure.includeTagText, false);
  assert.equal(value.calls.structure.lastPage, 2);
  assert.equal(value.calls.extract, 1);

  for (const [id, evidenceRef] of [
    ['heading-role-sequence', 'poppler.pdfinfo-struct'],
    ['list-role-shape', 'poppler.pdfinfo-struct'],
    ['artifact-classification', 'poppler.pdfinfo-struct'],
    ['font-tounicode', 'poppler.pdffonts'],
    ['font-embedding', 'poppler.pdffonts'],
    ['image-alt-text', 'poppler.pdfimages-list'],
  ]) {
    assert.deepEqual(byId.get(id)?.evidenceRefs, [evidenceRef], id);
  }
  assert.equal(byId.get('heading-role-sequence').status, 'warning');
  assert.equal(byId.get('list-role-shape').status, 'pass');
  assert.equal(byId.get('artifact-classification').status, 'not-checked');
  assert.equal(byId.get('image-alt-text').status, 'not-checked');
  assert.equal(byId.get('reading-order').status, 'not-checked');
  assert.equal(byId.get('pdf-ua-conformance').status, 'not-checked');
  assert.match(byId.get('reading-order').summary, /cannot prove reading order/u);
  assert.match(byId.get('pdf-ua-conformance').summary, /does not validate PDF\/UA/u);
  assert.equal(byId.get('font-tounicode').status, 'fail');
  assert.equal(byId.get('font-embedding').status, 'fail');

  assert.equal(report.remediationPlan.status, 'proposal-only');
  assert.ok(report.remediationPlan.candidates.some(({ action }) => action === 'repair-heading-hierarchy'));
  assert.ok(report.remediationPlan.candidates.some(({ action }) => action === 'author-reading-order'));
  assert.ok(report.remediationPlan.candidates.some(({ action }) => action === 'review-artifact-classification'));
  assert.ok(report.remediationPlan.candidates.some(({ action }) => action === 'repair-font-unicode-mapping'));
  assert.ok(report.remediationPlan.candidates.some(({ action }) => action === 'author-image-alt-text'));
  assert.ok(report.remediationPlan.candidates.every(({ status }) => status === 'proposed-not-applied'));
  assert.deepEqual(report.limitations, ACCESSIBILITY_REVIEW_LIMITATIONS);
  assert.doesNotMatch(JSON.stringify(report), /SECRET-|\/private\/|%PDF/u);
  assert.equal('pdf' in report, false);
  assert.equal('applied' in report, false);
  assert.equal('inferredReadingOrder' in report, false);
});

test('R07 subclaim review rejects incomplete providers instead of using a generic synthetic fallback', () => {
  const value = fixture();
  assert.throws(
    () => new AccessibilityReviewService({
      store: { getDocument: () => ({ id: documentId, sha256: sourceDigest }), verifySource: async () => true },
      pdfService: { inspect: value.service },
    }),
    /read-only PdfService inspection methods/u,
  );
});
