import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { AccessibilityReviewService } from '../scripts/host/accessibility-review-service.mjs';
import { ACCESSIBILITY_REVIEW_LIMITATIONS } from '../scripts/host/accessibility-review-report.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const SECRET_TEXT = 'R07-SUBCLAIM-SECRET-TEXT';
const SECRET_PATH = '/private/r07/source.pdf';
const SOURCE_BYTES_MARKER = '%PDF-SECRET-BYTES';

const COMPLETE_TAGS = [
  { depth: 0, value: 'Document' },
  { depth: 2, value: 'H1' },
  { depth: 4, value: 'H2' },
  { depth: 2, value: 'L' },
  { depth: 4, value: 'LI' },
  { depth: 6, value: 'LBody' },
  { depth: 2, value: 'Artifact' },
];

async function fixture(t, {
  tagLines = COMPLETE_TAGS,
  fonts = [{ unicode: 'yes', embedded: 'yes' }],
  structureDigest = 'source',
  tagged = 'yes',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r07-subclaims-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const sourceBytes = Buffer.from(makeTextPdf(SOURCE_BYTES_MARKER));
  const document = await store.createDocument({
    stream: Readable.from([sourceBytes]),
    displayName: 'r07-subclaims.pdf',
    mediaType: 'application/pdf',
  });
  let verifyCount = 0;
  const verifySource = store.verifySource.bind(store);
  store.verifySource = async (...args) => {
    verifyCount += 1;
    return verifySource(...args);
  };
  const pdfService = {
    async inspect() {
      return { pageCount: 1, tagged, title: 'R07 title', form: 'none' };
    },
    async inspectStructure(id) {
      return {
        sourceDigest: structureDigest === 'source' ? store.getDocument(id).sha256 : structureDigest,
        pageRange: { firstPage: 1, lastPage: 1 },
        taggedStructure: { present: tagged === 'yes', includesText: false, lines: tagLines },
        xmpMetadata: { xml: `<rdf:Description source="${SECRET_PATH}"><dc:language><rdf:Bag><rdf:li>en-US</rdf:li></rdf:Bag></dc:language></rdf:Description>` },
        customMetadata: [{ name: 'SourcePath', value: SECRET_PATH }],
        urls: [],
      };
    },
    async listFonts() { return fonts; },
    async listImages() {
      return [{
        page: 1, number: 0, objectId: 8, generation: 0, width: 100, height: 200,
        rawImagePayload: 'R07-RAW-IMAGE-BYTES',
      }];
    },
    async extractText() { return [{ page: 1, text: SECRET_TEXT }]; },
  };
  return {
    service: new AccessibilityReviewService({ store, pdfService }),
    document,
    sourcePath: store.getSourcePath(document.id),
    store,
    get verifyCount() { return verifyCount; },
  };
}

function check(report, id) {
  return report.checks.find((entry) => entry.id === id);
}

test('heading and list evidence stays heuristic while Artifact inventory stays review-only', async (t) => {
  const valid = await fixture(t);
  const report = await valid.service.review(valid.document.id);
  assert.equal(report.sourceDigest, valid.document.sha256);
  assert.equal(report.evidence.tagRoles.roleCounts.Artifact, 1);
  assert.equal(check(report, 'heading-role-sequence').status, 'pass');
  assert.equal(check(report, 'list-role-shape').status, 'pass');
  assert.equal(check(report, 'artifact-classification').status, 'not-checked');
  assert.match(check(report, 'artifact-classification').summary, /not proven/u);
  assert.match(ACCESSIBILITY_REVIEW_LIMITATIONS[1], /bounded heuristics/u);
  assert.match(ACCESSIBILITY_REVIEW_LIMITATIONS[1], /reading order or semantics/u);
  assert.equal(check(report, 'reading-order').status, 'not-checked');
  assert.equal(check(report, 'pdf-ua-conformance').status, 'not-checked');
  assert.equal(report.remediationPlan.status, 'proposal-only');
  assert.equal(report.remediationPlan.candidates.every(({ status }) => status === 'proposed-not-applied'), true);

  const violations = await fixture(t, {
    tagLines: [
      { depth: 0, value: 'Document' }, { depth: 2, value: 'H1' }, { depth: 4, value: 'H3' },
      { depth: 2, value: 'L' }, { depth: 4, value: 'P' }, { depth: 6, value: 'LI' },
    ],
  });
  const warning = await violations.service.review(violations.document.id);
  assert.equal(check(warning, 'heading-role-sequence').status, 'warning');
  assert.equal(check(warning, 'list-role-shape').status, 'warning');
  assert.equal(check(warning, 'pdf-ua-conformance').status, 'not-checked');
});

test('font ToUnicode and embedding claims reflect only bounded Poppler evidence', async (t) => {
  const mixed = await fixture(t, {
    fonts: [
      { unicode: 'yes', embedded: 'yes' },
      { unicode: 'no', embedded: 'no' },
      { unicode: 'unknown', embedded: 'unknown' },
    ],
  });
  const report = await mixed.service.review(mixed.document.id);
  assert.deepEqual({
    unicodeFonts: report.evidence.unicodeFonts,
    nonUnicodeFonts: report.evidence.nonUnicodeFonts,
    unknownUnicodeFonts: report.evidence.unknownUnicodeFonts,
    embeddedFonts: report.evidence.embeddedFonts,
    nonEmbeddedFonts: report.evidence.nonEmbeddedFonts,
    unknownEmbeddedFonts: report.evidence.unknownEmbeddedFonts,
  }, {
    unicodeFonts: 1, nonUnicodeFonts: 1, unknownUnicodeFonts: 1,
    embeddedFonts: 1, nonEmbeddedFonts: 1, unknownEmbeddedFonts: 1,
  });
  assert.equal(check(report, 'font-tounicode').status, 'fail');
  assert.equal(check(report, 'font-embedding').status, 'fail');
  assert.deepEqual(check(report, 'font-tounicode').evidenceRefs, ['poppler.pdffonts']);
  assert.equal(check(report, 'pdf-ua-conformance').status, 'not-checked');

  const unknown = await fixture(t, { fonts: [{ unicode: 'unknown', embedded: 'unknown' }] });
  const unknownReport = await unknown.service.review(unknown.document.id);
  assert.equal(check(unknownReport, 'font-tounicode').status, 'warning');
  assert.equal(check(unknownReport, 'font-embedding').status, 'warning');
});

test('review binds the exact immutable source and publishes bounded evidence without source leakage or mutation', async (t) => {
  const state = await fixture(t);
  const before = await readFile(state.sourcePath);
  const report = await state.service.review(state.document.id);
  const serialized = JSON.stringify(report);
  assert.equal(report.sourceDigest, state.document.sha256);
  assert.equal(report.remediationPlan.sourceSha256, state.document.sha256);
  assert.ok(Buffer.byteLength(serialized) <= 128 * 1024);
  assert.doesNotMatch(serialized, new RegExp(`${SECRET_TEXT}|${SECRET_PATH}|R07-RAW-IMAGE-BYTES|%PDF`, 'u'));
  assert.deepEqual(await readFile(state.sourcePath), before);
  assert.equal(await state.store.verifySource(state.document.id), true);
  assert.throws(() => state.store.getArtifact('00000000-0000-4000-8000-000000000000'), { code: 'ARTIFACT_NOT_FOUND' });
  assert.ok(state.verifyCount >= 2);

  const wrongDigest = await fixture(t, { structureDigest: 'b'.repeat(64) });
  await assert.rejects(wrongDigest.service.review(wrongDigest.document.id), { code: 'INVALID_ENGINE_OUTPUT', status: 502 });
});
