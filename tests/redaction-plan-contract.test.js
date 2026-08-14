import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createRedactionApplicationRequest,
  createRedactionPlanRequest,
  createRedactionPlanReportRequest,
  isSourceBoundRedactionPlan,
  sourceBoundRedactionPlans,
  validateAppliedRedactionPlanResponse,
  validateCreatedRedactionPlanResponse,
  validateRedactionPlanReport,
} from '../src/core/redaction-plan-contract.js';

const sourceSha256 = 'a'.repeat(64);
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
const canonicalDigest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const plan = {
  id: 'plan-1',
  type: 'redaction-plan',
  profile: 'source-bound-redaction-plan-v1',
  schemaVersion: 1,
  status: 'proposed-not-applied',
  createdAtLocal: '2026-07-19T10:00:00.000Z',
  sourceSha256,
  coordinateSpace: 'normalized-cropbox-top-left-v1',
  marks: [
    { id: 'mark-1', page: 1, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
    { id: 'mark-2', page: 2, fullPage: true },
  ],
  applicationProfile: 'verified-raster-burn-v2',
  planSha256: 'b'.repeat(64),
};

test('redaction-plan requests are exact, normalized, bounded, and text-free', () => {
  const created = createRedactionPlanRequest({
    sourceSha256,
    expectedWorkspaceRevision: 3,
    targets: [{ page: 1, region: { x: '0.1', y: 0.2, width: 0.3, height: 0.1 } }],
  });
  assert.deepEqual(created, {
    schemaVersion: 1,
    profile: 'source-bound-redaction-plan-v1',
    sourceSha256,
    expectedWorkspaceRevision: 3,
    targets: [{ page: 1, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }],
  });
  const applied = createRedactionApplicationRequest({
    sourceSha256,
    expectedWorkspaceRevision: 4,
    planId: 'plan-1',
    planSha256: 'b'.repeat(64),
    markIds: ['mark-1'],
  });
  assert.equal(JSON.stringify(applied).includes('removedText'), false);
  assert.equal(JSON.stringify(applied).includes('region'), false);
  assert.throws(() => createRedactionPlanRequest({
    sourceSha256,
    expectedWorkspaceRevision: 0,
    targets: [{ page: 1, region: { x: 0, y: 0, width: 1, height: 1, extra: true } }],
  }), /exactly x, y, width, and height/u);
  assert.throws(() => createRedactionApplicationRequest({
    sourceSha256,
    expectedWorkspaceRevision: 0,
    planId: 'plan-1',
    planSha256: 'b'.repeat(64),
    markIds: ['same', 'same'],
  }), /unique/u);
  assert.throws(() => createRedactionPlanRequest({
    sourceSha256,
    expectedWorkspaceRevision: 0,
    targets: [
      { page: 1, fullPage: true },
      { page: 1, region: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    ],
  }), /cannot overlap/u);
});

test('redaction-plan identifiers remain opaque strings', () => {
  assert.throws(() => createRedactionApplicationRequest({
    sourceSha256, expectedWorkspaceRevision: 0, planId: 123,
    planSha256: 'b'.repeat(64), markIds: ['mark-1'],
  }), /planId is invalid/u);
  assert.throws(() => createRedactionApplicationRequest({
    sourceSha256, expectedWorkspaceRevision: 0, planId: 'plan-1',
    planSha256: 'b'.repeat(64), markIds: [123],
  }), /markId is invalid/u);
});

test('only current strict source-bound plans enter immutable browser state', () => {
  assert.equal(isSourceBoundRedactionPlan(plan, sourceSha256), true);
  assert.equal(isSourceBoundRedactionPlan(plan, 'c'.repeat(64)), false);
  const filtered = sourceBoundRedactionPlans({
    namespaces: {
      redactions: [
        { id: 'legacy', type: 'redaction-plan', status: 'proposed-not-applied', marks: [] },
        plan,
      ],
    },
  }, sourceSha256);
  assert.deepEqual(filtered, [plan]);
  assert.equal(Object.isFrozen(filtered[0].marks[0].region), true);
  assert.throws(() => { filtered[0].marks[0].region.x = 0.9; }, TypeError);
  const internal = structuredClone(plan);
  internal.marks[0] = {
    ...internal.marks[0],
    pageGeometrySha256: 'c'.repeat(64),
    textBinding: { hmacSha256: 'd'.repeat(64), length: 18 },
  };
  const sanitized = sourceBoundRedactionPlans({ namespaces: { redactions: [internal] } }, sourceSha256);
  assert.deepEqual(sanitized, [plan]);
  assert.equal(JSON.stringify(sanitized).includes('hmacSha256'), false);
  assert.equal(isSourceBoundRedactionPlan({ ...plan, createdAtLocal: 'July 19, 2026' }, sourceSha256), false);
  assert.equal(isSourceBoundRedactionPlan({ ...plan, marks: [plan.marks[0], { ...plan.marks[0], id: 'mark-copy' }] }, sourceSha256), false);
  assert.equal(isSourceBoundRedactionPlan({ ...plan, marks: [{ id: 'whole-page', page: 2, fullPage: true }, plan.marks[1]] }, sourceSha256), false);
});

test('redaction-plan host responses fail closed and retain proposal status', () => {
  const created = validateCreatedRedactionPlanResponse({ plan, revision: 4 }, sourceSha256);
  assert.equal(created.plan.status, 'proposed-not-applied');
  const applied = validateAppliedRedactionPlanResponse({
    artifact: { id: '11111111-1111-4111-8111-111111111111', sha256: 'c'.repeat(64) },
    application: {
      status: 'artifact-created',
      planStatus: 'proposed-not-applied',
      textEvidence: 'validated-transiently-not-retained',
    },
  });
  assert.equal(applied.application.status, 'artifact-created');
  assert.throws(() => validateAppliedRedactionPlanResponse({
    artifact: { id: '11111111-1111-4111-8111-111111111111', sha256: 'c'.repeat(64) },
    application: { status: 'redaction-applied', planStatus: 'applied', textEvidence: 'retained' },
  }), /invalid redaction-plan artifact receipt/u);
});

test('redaction-plan reports remain source-bound, geometry-only, and proposed-not-applied', async () => {
  const request = createRedactionPlanReportRequest({
    sourceSha256, expectedWorkspaceRevision: 4,
    planId: plan.id, planSha256: plan.planSha256,
  });
  assert.deepEqual(Object.keys(request), [
    'schemaVersion', 'profile', 'sourceSha256', 'expectedWorkspaceRevision',
    'planId', 'planSha256',
  ]);
  const report = {
    schemaVersion: 1, profile: 'source-bound-redaction-plan-report-v1',
    sourceSha256, workspaceRevision: 4, planId: plan.id, planSha256: plan.planSha256,
    planCreatedAtLocal: plan.createdAtLocal, coordinateSpace: plan.coordinateSpace,
    applicationProfile: plan.applicationProfile, marks: plan.marks,
    reportStatus: 'proposed-not-applied', pdfBytesChanged: false,
  };
  report.reportSha256 = canonicalDigest(report);
  const validated = await validateRedactionPlanReport(report, request);
  assert.equal(Object.isFrozen(validated.marks[0].region), true);
  assert.equal(JSON.stringify(validated).includes('textBinding'), false);
  await assert.rejects(validateRedactionPlanReport({
    ...report, removedText: 'private',
  }, request), /invalid source-bound redaction-plan report/u);
  await assert.rejects(validateRedactionPlanReport({
    ...report, reportStatus: 'applied', pdfBytesChanged: true,
  }, request), /invalid source-bound redaction-plan report/u);
  await assert.rejects(validateRedactionPlanReport({
    ...report, sourceSha256: 'c'.repeat(64),
  }, request), /invalid source-bound redaction-plan report/u);
  await assert.rejects(validateRedactionPlanReport({
    ...report, reportSha256: 'd'.repeat(64),
  }, request), /invalid canonical digest/u);
  await assert.rejects(validateRedactionPlanReport({
    ...report, marks: [{ ...report.marks[0], region: { ...report.marks[0].region, x: 0.2 } }, report.marks[1]],
  }, request), /invalid canonical digest/u);
  const reordered = Object.fromEntries(Object.entries(report).reverse());
  assert.deepEqual(await validateRedactionPlanReport(reordered, request), report);
});
