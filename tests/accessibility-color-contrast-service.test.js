import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCESSIBILITY_COLOR_CONTRAST_PROFILE } from '../scripts/host/accessibility-color-contrast-contract.mjs';
import { AccessibilityColorContrastReviewService } from '../scripts/host/accessibility-color-contrast-service.mjs';

const digest = 'a'.repeat(64); const documentId = '123e4567-e89b-42d3-a456-426614174000';
const sample = (overrides = {}) => ({ id: 'text-1', bounds: { x: 10, y: 10, width: 40, height: 12 }, foreground: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, background: { r: 1, g: 1, b: 1, a: 1 }, pairing: 'trusted-text-background', confidence: 'high', colorOnlyGroup: null, ...overrides });
function fixture({ evidence = {}, sourceDrift = false, pageCount = 1 } = {}) {
  let verified = 0; const store = { getDocument: () => ({ sha256: digest, pageCount }), verifySource: async () => { verified += 1; if (sourceDrift && verified > 1) throw Object.assign(new Error('changed'), { code: 'SOURCE_INTEGRITY_FAILED' }); } };
  const renderer = { inspect: async (_id, { page, sourceSha256 }) => ({ renderer: 'poppler-raster-evidence-v1', sourceSha256, page, width: 100, height: 100, colorSpace: 'sRGB', samples: [sample(), ...(evidence.samples ?? [])], colorOnlyGroups: evidence.colorOnlyGroups ?? [], warnings: evidence.warnings ?? [] }) };
  return { service: new AccessibilityColorContrastReviewService({ store, renderer }), state: () => verified };
}
function request() { return { profile: ACCESSIBILITY_COLOR_CONTRAST_PROFILE, sourceSha256: digest, pages: 'all-pages' }; }

test('contrast review is source-bound, immutable, deterministic, and human-review-only', async () => {
  const { service } = fixture(); const first = await service.review(documentId, request()); const second = await service.review(documentId, request());
  assert.deepEqual(first, second); assert.equal(first.status, 'review-required'); assert.equal(first.pages[0].findings[0].status, 'warning'); assert.equal(first.pages[0].findings[0].contrast < 4.5, true); assert.equal(Object.isFrozen(first), true); assert.equal(first.evidence.sourceBound, true); assert.equal(first.reportSha256.length, 64); assert.doesNotMatch(JSON.stringify(first), /SECRET|\/private|text content/u);
});

test('contrast review flags color-only distinctions and explicit uncertainty', async () => {
  const { service } = fixture({ evidence: { samples: [sample({ id: 'transparent', foreground: { r: 0, g: 0, b: 0, a: 0 }, colorOnlyGroup: 'legend' }), sample({ id: 'raster', pairing: 'trusted-raster-region', confidence: 'high', colorOnlyGroup: 'legend' })], colorOnlyGroups: [{ id: 'legend', sampleIds: ['transparent', 'raster'], nonColorCue: false }], warnings: ['gradient-background'] } });
  const report = await service.review(documentId, request()); const findings = report.pages[0].findings;
  assert.equal(findings.some(({ reason }) => reason === 'transparent-color'), true); assert.equal(findings.some(({ reason }) => reason === 'raster-region-requires-human-pairing'), true); assert.equal(findings.some(({ reason }) => reason === 'repeated-color-distinction-without-non-color-cue'), true); assert.equal(findings.some(({ reason }) => reason === 'gradient-background'), true);
});

test('contrast review rejects forged evidence, bounds, drift, and cancellation', async () => {
  const bad = fixture({ evidence: { samples: [sample({ foreground: { r: 2, g: 0, b: 0, a: 1 } })] } }); await assert.rejects(bad.service.review(documentId, request()), { code: 'ACCESSIBILITY_COLOR_CONTRAST_FAILED' });
  await assert.rejects(fixture({ pageCount: 201 }).service.review(documentId, request()), { code: 'ACCESSIBILITY_COLOR_CONTRAST_PAGE_LIMIT' });
  await assert.rejects(fixture({ sourceDrift: true }).service.review(documentId, request()), { code: 'SOURCE_INTEGRITY_FAILED' });
  const controller = new AbortController(); controller.abort(); await assert.rejects(fixture().service.review(documentId, request(), { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  const proxy = new Proxy(request(), {}); await assert.rejects(fixture().service.review(documentId, proxy), { code: 'ACCESSIBILITY_COLOR_CONTRAST_OPTIONS_INVALID' });
});

test('contrast review rejects renderer accessors and proxy evidence', async () => {
  const store = { getDocument: () => ({ sha256: digest, pageCount: 1 }), verifySource: async () => {} };
  const base = { renderer: 'poppler-raster-evidence-v1', sourceSha256: digest, page: 1, width: 100, height: 100, colorSpace: 'sRGB', samples: [], colorOnlyGroups: [], warnings: [] };
  for (const evidence of [new Proxy(base, {}), Object.defineProperty({ ...base }, 'page', { get: () => 1 })]) {
    const service = new AccessibilityColorContrastReviewService({ store, renderer: { pageCount: async () => 1, inspect: async () => evidence } });
    await assert.rejects(service.review(documentId, request()), { code: 'ACCESSIBILITY_COLOR_CONTRAST_FAILED' });
  }
});

test('contrast review rejects ICC evidence instead of guessing a color transform', async () => {
  const store = { getDocument: () => ({ sha256: digest, pageCount: 1 }), verifySource: async () => {} };
  const renderer = { pageCount: async () => 1, inspect: async (_id, { sourceSha256 }) => ({ renderer: 'poppler-raster-evidence-v1', sourceSha256, page: 1, width: 100, height: 100, colorSpace: 'ICCBased', samples: [], colorOnlyGroups: [], warnings: [] }) };
  await assert.rejects(new AccessibilityColorContrastReviewService({ store, renderer }).review(documentId, request()), { code: 'ACCESSIBILITY_COLOR_CONTRAST_FAILED' });
});

test('contrast evidence bounds use renderer dimensions and group membership is bijective', async () => {
  const outOfBounds = fixture({ evidence: { samples: [sample({ bounds: { x: 99, y: 0, width: 2, height: 2 } })] } });
  await assert.rejects(outOfBounds.service.review(documentId, request()), { code: 'ACCESSIBILITY_COLOR_CONTRAST_FAILED' });
  const store = { getDocument: () => ({ sha256: digest, pageCount: 1 }), verifySource: async () => {} };
  const evidence = { renderer: 'poppler-raster-evidence-v1', sourceSha256: digest, page: 1, width: 100, height: 100, colorSpace: 'sRGB', samples: [sample({ colorOnlyGroup: null })], colorOnlyGroups: [{ id: 'dangling', sampleIds: ['text-1', 'missing'], nonColorCue: false }], warnings: [] };
  const service = new AccessibilityColorContrastReviewService({ store, renderer: { pageCount: async () => 1, inspect: async () => evidence } });
  await assert.rejects(service.review(documentId, request()), { code: 'ACCESSIBILITY_COLOR_CONTRAST_FAILED' });
});

test('high-contrast evidence passes the deterministic threshold', async () => {
  const { service } = fixture({ evidence: { samples: [sample({ id: 'black', foreground: { r: 0, g: 0, b: 0, a: 1 } })] } });
  const report = await service.review(documentId, request()); const pass = report.pages[0].findings.find(({ id }) => id === 'black');
  assert.equal(pass.status, 'pass'); assert.equal(pass.contrast, 21);
});
