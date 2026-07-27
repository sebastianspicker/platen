import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { validateAccessibilityReviewReport } from '../scripts/host/accessibility-review-report-validation.mjs';
import { AccessibilityReviewService } from '../scripts/host/accessibility-review-service.mjs';
import { sha256 } from '../scripts/host/accessibility-review-utils.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const documentId = '123e4567-e89b-42d3-a456-426614174000';

function resignReview(report, mutate) {
  const changed = structuredClone(report);
  mutate(changed);
  const { attempted: _attempted, unavailableReason: _unavailableReason, ...pdfkit } = changed.evidence.optionalPdfKit;
  const imageLocators = changed.remediationPlan.candidates
    .filter(({ action, target }) => action === 'author-image-alt-text' && target?.locator)
    .map(({ target }) => target.locator);
  changed.remediationPlan.reviewEvidenceSha256 = sha256({
    sourceSha256: changed.sourceDigest,
    checks: changed.checks,
    tagRoles: changed.evidence.tagRoles,
    optionalPdfKit: pdfkit,
    imageLocators,
  });
  const { reportSha256: _reportSha256, ...unsigned } = changed;
  return { ...unsigned, reportSha256: sha256(unsigned) };
}

function fixture({
  pages = 2, sourceFailsAfter = null, tagged = 'yes', fontUnicode = 'yes',
  pdfkitPermission = null, pdfkitError = null, pdfkitResult = null,
  tagLines = null, urls = [],
} = {}) {
  let verified = 0; let observedSignal = null;
  const store = {
    getDocument: (id) => ({ id, sha256: 'a'.repeat(64) }),
    verifySource: async () => { verified += 1; if (sourceFailsAfter !== null && verified > sourceFailsAfter) { const error = new Error('changed'); error.code = 'SOURCE_INTEGRITY_FAILED'; throw error; } return true; },
  };
  const pdfService = {
    inspect: async (_id, { signal }) => { observedSignal = signal; return { pageCount: pages, tagged, title: 'Accessible fixture', form: 'none' }; },
    inspectStructure: async (_id, { lastPage, includeTagText, signal }) => ({ sourceDigest: 'a'.repeat(64), pageRange: { firstPage: 1, lastPage }, taggedStructure: { present: tagged === 'yes', includesText: includeTagText, lines: tagged === 'yes' ? (tagLines ?? [{ depth: 0, value: 'Document' }, { depth: 2, value: 'P (block)' }]) : [] }, xmpMetadata: { xml: '<dc:language><rdf:Bag><rdf:li>en-US</rdf:li></rdf:Bag></dc:language>' }, customMetadata: [], urls, signal }),
    listFonts: async () => [{ unicode: fontUnicode, embedded: 'yes' }, { unicode: 'yes', embedded: 'yes' }],
    listImages: async () => [{ page: 1, number: 0, objectId: 8, generation: 0, width: 100, height: 200 }],
    extractText: async (_id, count) => Array.from({ length: count }, (_value, index) => ({ page: index + 1, text: index ? '' : 'visible only inside service' })),
  };
  const pdfkitInspectionService = pdfkitPermission === null && pdfkitError === null && pdfkitResult === null ? null : {
    inspect: async () => {
      if (pdfkitError) throw pdfkitError;
      return pdfkitResult ?? ({
      sourceDigest: 'a'.repeat(64), pageCount: pages,
      document: { permissions: { contentAccessibility: pdfkitPermission, status: 'owner' } },
      pages: Array.from({ length: pages }, (_value, index) => ({ index: index + 1, widgets: [], widgetsTruncated: false })),
      pagesTruncated: false, outline: { items: [], truncated: false },
      });
    },
  };
  return {
    service: new AccessibilityReviewService({ store, pdfService, pdfkitInspectionService }),
    state: () => ({ verified, observedSignal }),
  };
}

test('accessibility review is deterministic, deeply immutable, source-bound, and does not disclose text or paths', async () => {
  const { service, state } = fixture(); const controller = new AbortController();
  const first = await service.review('123e4567-e89b-42d3-a456-426614174000', { signal: controller.signal });
  const second = await service.review('123e4567-e89b-42d3-a456-426614174000', { signal: controller.signal });
  assert.deepEqual(first, second); assert.equal(first.reportSha256.length, 64); assert.equal(Object.isFrozen(first.checks), true);
  assert.equal(first.kind, 'accessibility-review');
  assert.deepEqual(first.profile, { id: 'basic-local-review', title: 'Basic local accessibility review', version: 3 });
  assert.equal(first.sourceDigest, 'a'.repeat(64)); assert.equal('document' in first, false);
  assert.equal(first.status, 'review-required');
  assert.deepEqual(first.counts, { pass: 8, warning: 1, fail: 0, 'not-checked': 10 });
  assert.equal(first.evidence.emptyExtractedTextPages, 1);
  assert.equal(first.evidence.urls, 0);
  assert.equal(first.evidence.imageTargets.length, 1);
  assert.equal(first.checks.find(({ id }) => id === 'image-alt-text').status, 'not-checked');
  assert.equal(first.checks.find(({ id }) => id === 'pdf-ua-conformance').status, 'not-checked');
  assert.equal(first.checks.find(({ id }) => id === 'empty-extracted-text-pages').status, 'warning');
  assert.equal(first.evidence.tagRoles.roleCounts.Document, 1);
  assert.equal(first.evidence.tagRoles.hierarchyCoverage, 'complete');
  assert.deepEqual(first.checks.find(({ id }) => id === 'font-tounicode').evidenceRefs, ['poppler.pdffonts']);
  assert.equal(first.remediationPlan.status, 'proposal-only');
  assert.equal(first.remediationPlan.kind, 'accessibility-remediation-plan');
  assert.equal(first.remediationPlan.sourceSha256, 'a'.repeat(64));
  assert.equal(first.remediationPlan.reviewEvidenceSha256.length, 64);
  assert.equal(first.remediationPlan.candidateCount, 6);
  assert.equal(first.remediationPlan.candidates.every(({ status }) => status === 'proposed-not-applied'), true);
  assert.doesNotMatch(JSON.stringify(first), /visible only|\/private|PDF\/UA validated/i);
  assert.equal(state().verified, 4); assert.equal(state().observedSignal, controller.signal);
  const validated = validateAccessibilityReviewReport(first, { expectedSourceDigest: 'a'.repeat(64) });
  assert.equal(validated, first);
  assert.equal(validateAccessibilityReviewReport(validated, { expectedSourceDigest: 'a'.repeat(64) }), first);
  assert.equal(validated.reportSha256, first.reportSha256);
  assert.equal(Object.isFrozen(validated.evidence), true);
  assert.throws(
    () => validateAccessibilityReviewReport({ ...first, reportSha256: 'c'.repeat(64) }, { expectedSourceDigest: 'a'.repeat(64) }),
    { code: 'ACCESSIBILITY_REVIEW_INTEGRITY_FAILED', status: 502 },
  );
  assert.throws(
    () => validateAccessibilityReviewReport(new Proxy(first, {}), { expectedSourceDigest: 'a'.repeat(64) }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID', status: 502 },
  );
  const leakedReason = resignReview(first, (changed) => {
    changed.remediationPlan.candidates[0].reason = 'Raw extracted text: SECRET; source /private/tmp/input.pdf';
  });
  assert.throws(
    () => validateAccessibilityReviewReport(leakedReason, { expectedSourceDigest: 'a'.repeat(64) }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID', status: 502 },
  );
  const leakedSummary = resignReview(first, (changed) => {
    changed.checks[0].summary = 'Raw extracted text: SECRET; source /private/tmp/input.pdf';
  });
  assert.throws(
    () => validateAccessibilityReviewReport(leakedSummary, { expectedSourceDigest: 'a'.repeat(64) }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID', status: 502 },
  );
  const noncanonicalUrlSummary = resignReview(first, (changed) => {
    const check = changed.checks.find(({ id }) => id === 'link-bookmark-semantics');
    check.summary = check.summary.replace(/^0 object URLs/u, '000 object URLs');
  });
  assert.throws(
    () => validateAccessibilityReviewReport(noncanonicalUrlSummary, { expectedSourceDigest: 'a'.repeat(64) }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID', status: 502 },
  );
  const forgedImageTarget = resignReview(first, (changed) => {
    const candidate = changed.remediationPlan.candidates.find(({ target }) => target);
    candidate.target = { page: 2, imageNumber: 49_999, locator: 'c'.repeat(64) };
  });
  assert.throws(
    () => validateAccessibilityReviewReport(forgedImageTarget, { expectedSourceDigest: 'a'.repeat(64) }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID', status: 502 },
  );
  const malformedRoles = resignReview(first, (changed) => {
    changed.evidence.tagRoles.roleCounts = null;
  });
  assert.throws(
    () => validateAccessibilityReviewReport(malformedRoles, { expectedSourceDigest: 'a'.repeat(64) }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID', status: 502 },
  );
  const selfConsistentForgedTarget = resignReview(first, (changed) => {
    const target = { page: 2, imageNumber: 49_999, locator: 'c'.repeat(64) };
    changed.evidence.imageTargets[0] = target;
    const candidate = changed.remediationPlan.candidates.find((entry) => entry.target);
    candidate.target = target;
  });
  assert.throws(
    () => validateAccessibilityReviewReport(selfConsistentForgedTarget, { expectedSourceDigest: 'a'.repeat(64) }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID', status: 502 },
  );
});

test('accessibility review enforces its page ceiling and rechecks immutable source after inspection', async () => {
  await assert.rejects(fixture({ pages: 201 }).service.review('123e4567-e89b-42d3-a456-426614174000'), { code: 'ACCESSIBILITY_PAGE_LIMIT', status: 422 });
  await assert.rejects(fixture({ sourceFailsAfter: 1 }).service.review('123e4567-e89b-42d3-a456-426614174000'), { code: 'SOURCE_INTEGRITY_FAILED' });
});

test('accessibility review fails missing tag evidence and non-Unicode font evidence without claiming PDF/UA validation', async () => {
  const report = await fixture({ tagged: 'no', fontUnicode: 'no' }).service.review('123e4567-e89b-42d3-a456-426614174000');
  assert.equal(report.status, 'fail');
  assert.equal(report.checks.find(({ id }) => id === 'tagged-indicator').status, 'fail');
  assert.equal(report.checks.find(({ id }) => id === 'tag-structure-listing').status, 'fail');
  assert.equal(report.checks.find(({ id }) => id === 'font-tounicode').status, 'fail');
  assert.equal(report.checks.find(({ id }) => id === 'pdf-ua-conformance').status, 'not-checked');
});

test('accessibility review uses optional isolated PDFKit permission evidence without claiming semantics', async () => {
  const permitted = await fixture({ pdfkitPermission: true }).service.review('123e4567-e89b-42d3-a456-426614174000');
  assert.equal(permitted.checks.find(({ id }) => id === 'screen-reader-permissions').status, 'pass');
  assert.equal(permitted.evidence.optionalPdfKit.available, true);
  assert.equal(permitted.checks.find(({ id }) => id === 'pdf-ua-conformance').status, 'not-checked');
  assert.equal(validateAccessibilityReviewReport(permitted, { expectedSourceDigest: 'a'.repeat(64) }).reportSha256, permitted.reportSha256);

  const denied = await fixture({ pdfkitPermission: false }).service.review('123e4567-e89b-42d3-a456-426614174000');
  assert.equal(denied.status, 'fail');
  assert.equal(denied.checks.find(({ id }) => id === 'screen-reader-permissions').status, 'fail');
  assert.equal(denied.remediationPlan.candidates.some(({ action }) => action === 'enable-assistive-access'), true);
  assert.equal(validateAccessibilityReviewReport(denied, { expectedSourceDigest: 'a'.repeat(64) }).reportSha256, denied.reportSha256);
});

test('tag hierarchy checks distinguish valid, invalid, and coverage-unknown ancestry', async () => {
  const valid = await fixture({
    tagLines: [
      { depth: 0, value: 'Document' },
      { depth: 2, value: 'L' }, { depth: 4, value: 'LI' }, { depth: 6, value: 'LBody' },
      { depth: 2, value: 'Table' }, { depth: 4, value: 'TR' }, { depth: 6, value: 'TH' }, { depth: 6, value: 'TD' },
    ],
  }).service.review(documentId);
  assert.equal(valid.checks.find(({ id }) => id === 'list-role-shape').status, 'pass');
  assert.equal(valid.checks.find(({ id }) => id === 'table-role-shape').status, 'pass');

  const invalid = await fixture({
    tagLines: [
      { depth: 0, value: 'Document' }, { depth: 2, value: 'L' }, { depth: 4, value: 'P' },
      { depth: 6, value: 'LI' }, { depth: 2, value: 'Table' }, { depth: 4, value: 'P' }, { depth: 6, value: 'TR' },
    ],
  }).service.review(documentId);
  assert.equal(invalid.checks.find(({ id }) => id === 'list-role-shape').status, 'warning');
  assert.equal(invalid.checks.find(({ id }) => id === 'table-role-shape').status, 'warning');

  const unknown = await fixture({
    tagLines: [
      { depth: 0, value: 'Document' }, { depth: 2, value: 'CustomContainer' },
      { depth: 4, value: 'L' }, { depth: 6, value: 'LI' }, { depth: 8, value: 'LBody' },
      { depth: 4, value: 'Table' }, { depth: 6, value: 'TR' }, { depth: 8, value: 'TH' },
    ],
  }).service.review(documentId);
  assert.equal(unknown.evidence.tagRoles.hierarchyCoverage, 'unknown');
  assert.equal(unknown.checks.find(({ id }) => id === 'list-role-shape').status, 'not-checked');
  assert.equal(unknown.checks.find(({ id }) => id === 'table-role-shape').status, 'not-checked');

  const malformed = await fixture({ tagLines: [{ depth: 0, value: 'Document' }, { depth: 4, value: 'L' }, { depth: 6, value: 'LI' }] }).service.review(documentId);
  assert.equal(malformed.evidence.tagRoles.malformedDepthTransitionCount, 1);
  assert.equal(malformed.checks.find(({ id }) => id === 'list-role-shape').status, 'not-checked');
});

test('tag review detects late heading violations and rejects unbounded role inventories', async () => {
  const headings = [{ depth: 0, value: 'Document' }, ...Array.from({ length: 1_024 }, () => ({ depth: 2, value: 'H1' })), { depth: 2, value: 'H3' }];
  const report = await fixture({ tagLines: headings }).service.review(documentId);
  assert.equal(report.evidence.tagRoles.headingCount, 1_025);
  assert.equal(report.checks.find(({ id }) => id === 'heading-role-sequence').status, 'warning');
  await assert.rejects(fixture({ tagLines: Array.from({ length: 50_001 }, () => ({ depth: 0, value: 'P' })) }).service.review(documentId), { code: 'ACCESSIBILITY_TAG_LIMIT', status: 413 });
});

test('optional PDFKit evidence fails closed except for an explicit unsupported-document outcome', async () => {
  const trustError = Object.assign(new Error('private workspace changed'), { code: 'PDFKIT_WORKSPACE_INVALID', status: 502 });
  await assert.rejects(fixture({ pdfkitError: trustError }).service.review(documentId), { code: 'PDFKIT_WORKSPACE_INVALID' });
  const malformed = { sourceDigest: 'b'.repeat(64), pageCount: 2, document: {}, pages: [] };
  await assert.rejects(fixture({ pdfkitResult: malformed }).service.review(documentId), { code: 'INVALID_ENGINE_OUTPUT', status: 502 });
  const unsupported = Object.assign(new Error('unsupported PDF'), { code: 'PDFKIT_DOCUMENT_UNSUPPORTED', status: 422 });
  const report = await fixture({ pdfkitError: unsupported }).service.review(documentId);
  assert.equal(report.evidence.optionalPdfKit.available, false);
  assert.equal(report.evidence.optionalPdfKit.unavailableReason, 'document-unsupported');
  assert.equal(report.checks.find(({ id }) => id === 'screen-reader-permissions').status, 'not-checked');
  assert.equal(validateAccessibilityReviewReport(report, { expectedSourceDigest: 'a'.repeat(64) }).reportSha256, report.reportSha256);
});

test('zero URL and outline inventory never claims link or bookmark semantics', async () => {
  const report = await fixture({ pdfkitPermission: true, urls: [] }).service.review(documentId);
  assert.equal(report.checks.find(({ id }) => id === 'link-bookmark-semantics').status, 'not-checked');
  assert.match(report.checks.find(({ id }) => id === 'link-bookmark-semantics').summary, /not proven/);
});

test('installed Poppler produces bounded semantic role evidence from a tagged source', async (context) => {
  try {
    await Promise.all([
      '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdffonts',
      '/opt/homebrew/bin/pdfimages', '/opt/homebrew/bin/pdftotext',
    ].map((path) => access(path)));
  } catch {
    context.skip('The fixed Poppler accessibility inspection tools are unavailable.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-accessibility-test-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const registry = new EngineRegistry();
  const pdfService = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const service = new AccessibilityReviewService({ store, pdfService });
  const source = await store.createDocument({
    stream: Readable.from([makeTextPdf('TAGGED ACCESSIBILITY PRIVATE TEXT', { tagged: true })]),
    displayName: 'tagged.pdf',
  });
  const report = await service.review(source.id);
  assert.equal(report.checks.find(({ id }) => id === 'tagged-indicator').status, 'pass');
  assert.equal(report.evidence.tagRoles.roleCounts.Document, 1);
  assert.equal(report.evidence.tagRoles.roleCounts.P, 1);
  assert.equal(report.remediationPlan.tagRoleEvidenceDigest.length, 64);
  assert.doesNotMatch(JSON.stringify(report), /TAGGED ACCESSIBILITY PRIVATE TEXT|\/private\//);
  assert.equal(await store.verifySource(source.id), true);
});
