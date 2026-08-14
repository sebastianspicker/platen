import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAccessibilityReviewReport } from '../../scripts/host/accessibility-review-report-validation.mjs';
import { canonical } from '../../scripts/host/accessibility-review-utils.mjs';

function registerHostileSnapshotTest({ fixture }) {
  test('accessibility review snapshots hostile JSON structures in deterministic first-failure order', async () => {
    const report = await fixture().service.review('123e4567-e89b-42d3-a456-426614174000');
    const trapOrder = [];
    const cases = [
      { name: 'boolean scalar reaches semantic validation', mutate: (changed) => { changed.evidence.tagRoles.roleCounts.Document = true; }, message: 'Accessibility tag-role counts are invalid.' },
      { name: 'non-finite scalar fails during snapshotting', mutate: (changed) => { changed.pageCount = Number.NaN; }, message: 'The accessibility review contains a non-finite number.' },
      { name: 'oversized text scalar fails during snapshotting', mutate: (changed) => { changed.kind = 'x'.repeat(128 * 1024 + 1); }, message: 'The accessibility review contains oversized text.' },
      { name: 'sparse array fails after descriptor collection', mutate: (changed) => { changed.evidence.imageTargets = new Array(1); }, message: 'The accessibility review requires dense data-only arrays.' },
      { name: 'non-plain object fails after descriptor collection', mutate: (changed) => { changed.evidence.tagRoles.roleCounts = Object.create({}); }, message: 'The accessibility review contains a non-plain object.' },
      {
        name: 'accessor property fails without invoking its getter',
        mutate: (changed) => {
          Object.defineProperty(changed.evidence.tagRoles.roleCounts, 'accessor', {
            enumerable: true,
            get() { trapOrder.push('accessor'); throw new Error('accessor should not run'); },
          });
        },
        message: 'The accessibility review requires data properties only.',
      },
      {
        name: 'non-enumerable property fails as a data-only shape violation',
        mutate: (changed) => { Object.defineProperty(changed.evidence.tagRoles.roleCounts, 'hidden', { value: 1 }); },
        message: 'The accessibility review requires data properties only.',
      },
      { name: 'symbol property fails as a data-only shape violation', mutate: (changed) => { changed.evidence.tagRoles.roleCounts[Symbol('role')] = 1; }, message: 'The accessibility review requires data properties only.' },
      {
        name: 'proxy fails before descriptor traps',
        mutate: (changed) => {
          changed.evidence.tagRoles.roleCounts = new Proxy({}, {
            ownKeys() { trapOrder.push('proxy'); throw new Error('descriptor trap should not run'); },
          });
        },
        message: 'The accessibility review must be acyclic plain JSON data.',
      },
      { name: 'cycle fails before repeated descriptor traversal', mutate: (changed) => { changed.evidence.tagRoles.roleCounts.self = changed.evidence.tagRoles.roleCounts; }, message: 'The accessibility review must be acyclic plain JSON data.' },
      {
        name: 'depth limit fails before semantic validation',
        mutate: (changed) => {
          let nested = null;
          for (let index = 0; index < 14; index += 1) nested = { nested };
          changed.evidence.tagRoles.roleCounts.deep = nested;
        },
        message: 'The accessibility review exceeds its structural limits.',
      },
      { name: 'item budget fails before semantic validation', mutate: (changed) => { changed.evidence.tagRoles.roleCounts = Array.from({ length: 20_000 }, () => null); }, message: 'The accessibility review exceeds its structural limits.' },
    ];
    for (const scenario of cases) {
      const changed = structuredClone(report);
      scenario.mutate(changed);
      assert.throws(
        () => validateAccessibilityReviewReport(changed, { expectedSourceDigest: report.sourceDigest }),
        { code: 'ACCESSIBILITY_REVIEW_INVALID', message: scenario.message, status: 502 },
        scenario.name,
      );
    }
    assert.deepEqual(trapOrder, []);
  });
}

function registerValidationStagesTest({ fixture, assertReSignedReviewFailure, resignReview }) {
  test('accessibility review validator stages preserve re-signed first failures', async () => {
    const report = await fixture().service.review('123e4567-e89b-42d3-a456-426614174000');
    const stages = [
      { name: 'root identity', mutate: (changed) => { changed.kind = 'forged-review'; }, message: 'Accessibility review identity or source binding is invalid.' },
      { name: 'unavailable PDFKit state', mutate: (changed) => { changed.evidence.optionalPdfKit = { attempted: true, available: false }; }, message: 'Unavailable PDFKit evidence has an invalid state.' },
      { name: 'source version', mutate: (changed) => { changed.evidence.sources[0].version = 'forged'; }, message: 'Accessibility evidence source version metadata is invalid.' },
      { name: 'source order', mutate: (changed) => { changed.evidence.sources[0].id = 'review-profile.capability-boundary'; }, message: 'Accessibility evidence sources are not in the fixed profile order.' },
      { name: 'evidence totals', mutate: (changed) => { changed.evidence.fonts += 1; }, message: 'Accessibility font evidence counts are inconsistent.' },
      {
        name: 'plan target shape',
        mutate: (changed) => {
          const candidate = changed.remediationPlan.candidates.find(({ target }) => target);
          candidate.target = { ...candidate.target, locator: 'not-a-digest' };
        },
        message: 'Accessibility remediation target is invalid.',
      },
      {
        name: 'plan target binding',
        mutate: (changed) => {
          const candidate = changed.remediationPlan.candidates.find(({ target }) => target);
          candidate.target = { ...candidate.target, page: 2 };
        },
        message: 'Accessibility remediation target does not match its source evidence.',
      },
      {
        name: 'plan evidence binding', mutate: () => {},
        afterResign: (changed) => { changed.remediationPlan.reviewEvidenceSha256 = 'c'.repeat(64); },
        message: 'Accessibility remediation plan evidence binding is invalid.',
      },
      { name: 'limitations', mutate: (changed) => { changed.limitations[0] = 'forged limitation'; }, message: 'Accessibility review limitations do not match the fixed non-conformance boundary.' },
    ];
    for (const stage of stages) {
      if (!stage.afterResign) {
        assertReSignedReviewFailure(report, stage.mutate, stage.message);
        continue;
      }
      const changed = resignReview(report, stage.mutate);
      stage.afterResign(changed);
      assert.throws(
        () => validateAccessibilityReviewReport(changed, {
          expectedSourceDigest: report.sourceDigest,
          requireTrustedIssue: false,
        }),
        { code: 'ACCESSIBILITY_REVIEW_INVALID', message: stage.message, status: 502 },
      );
    }

    const integrity = resignReview(report, () => {});
    integrity.reportSha256 = 'd'.repeat(64);
    assert.throws(
      () => validateAccessibilityReviewReport(integrity, { expectedSourceDigest: report.sourceDigest, requireTrustedIssue: false }),
      { code: 'ACCESSIBILITY_REVIEW_INTEGRITY_FAILED', message: 'Accessibility review digest verification failed.', status: 502 },
    );

    const reSigned = resignReview(report, () => {});
    assert.throws(
      () => validateAccessibilityReviewReport(reSigned, { expectedSourceDigest: report.sourceDigest }),
      { code: 'ACCESSIBILITY_REVIEW_INVALID', message: 'Accessibility review publication requires an exact host-issued report.', status: 502 },
    );

    const serialized = canonical(reSigned);
    const byteLength = Buffer.byteLength;
    Buffer.byteLength = (value, ...options) => value === serialized ? 128 * 1024 + 1 : byteLength(value, ...options);
    try {
      assert.throws(
        () => validateAccessibilityReviewReport(reSigned, { expectedSourceDigest: report.sourceDigest, requireTrustedIssue: false }),
        { code: 'ACCESSIBILITY_REVIEW_INVALID', message: 'Accessibility review exceeds its report-size limit.', status: 502 },
      );
    } finally {
      Buffer.byteLength = byteLength;
    }
  });
}

export function registerAccessibilityReviewValidatorTests(context) {
  registerHostileSnapshotTest(context);
  registerValidationStagesTest(context);
}
