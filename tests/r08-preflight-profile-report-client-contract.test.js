import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildPreflightReport } from '../scripts/host/preflight-rules.mjs';
import { createPrepressEndpoints } from '../src/core/local-host-prepress-endpoints.js';
import { validatePreflightReviewReport } from '../src/core/preflight-report-contract.js';

const source = 'a'.repeat(64);

function report(profile = 'print-review') {
  return buildPreflightReport({
    profile,
    document: { sha256: source },
    inspection: { pageCount: 1, encrypted: 'no', javascript: 'no' },
    structure: {
      sourceDigest: source,
      pageRange: { firstPage: 1, lastPage: 1, truncated: false },
      pageBoxes: [{
        page: 1, widthPoints: 612, heightPoints: 792,
        boxes: {
          mediaBox: { left: 0, bottom: 0, right: 612, top: 792 },
          bleedBox: { left: 9, bottom: 9, right: 603, top: 783 },
          trimBox: { left: 18, bottom: 18, right: 594, top: 774 },
        },
      }],
      xmpMetadata: { present: true },
    },
    fonts: [], images: [],
  });
}

function signed(original, overrides = {}) {
  const { reportSha256: _previous, ...payload } = structuredClone(original);
  const changed = { ...payload, ...overrides };
  return {
    ...changed,
    reportSha256: createHash('sha256').update(JSON.stringify(changed)).digest('hex'),
  };
}

test('R08 browser contract accepts and freezes exact fixed-profile host reports', async () => {
  for (const profile of ['print-review', 'archive-review']) {
    const validated = await validatePreflightReviewReport(report(profile), { expectedProfile: profile });
    assert.equal(validated.profile.id, profile);
    assert(Object.isFrozen(validated) && Object.isFrozen(validated.checks));
    assert(Object.isFrozen(validated.checks[0].evidence));
  }
});

test('R08 browser contract rejects tampering, source drift, profile drift, counts, and check order', async () => {
  const valid = report();
  await assert.rejects(validatePreflightReviewReport({ ...valid, reportSha256: 'b'.repeat(64) }), TypeError);
  await assert.rejects(validatePreflightReviewReport(signed(valid, { document: { ...valid.document, sha256: 'A'.repeat(64) } })), TypeError);
  await assert.rejects(validatePreflightReviewReport(signed(valid, { profile: { id: 'PDF/X-4', fixed: true } })), TypeError);
  await assert.rejects(validatePreflightReviewReport(signed(valid, { counts: { ...valid.counts, pass: valid.counts.pass + 1 } })), TypeError);
  const reorderedCounts = { warning: valid.counts.warning, pass: valid.counts.pass, fail: valid.counts.fail, 'not-checked': valid.counts['not-checked'] };
  await assert.rejects(validatePreflightReviewReport(signed(valid, { counts: reorderedCounts })), TypeError);
  const checks = structuredClone(valid.checks); [checks[0], checks[1]] = [checks[1], checks[0]];
  await assert.rejects(validatePreflightReviewReport(signed(valid, { checks })), TypeError);
  await assert.rejects(validatePreflightReviewReport(valid, { expectedProfile: 'archive-review' }), TypeError);
});

test('R08 browser contract rejects private, hostile, cyclic, and non-JSON report data', async () => {
  const valid = report();
  const checks = structuredClone(valid.checks);
  checks[0].evidence.path = '/private/preflight.json';
  await assert.rejects(validatePreflightReviewReport(signed(valid, { checks })), TypeError);

  const accessor = structuredClone(valid);
  Object.defineProperty(accessor.document, 'sha256', { enumerable: true, get() { return source; } });
  await assert.rejects(validatePreflightReviewReport(accessor), TypeError);
  await assert.rejects(validatePreflightReviewReport(new Proxy(valid, {})), TypeError);

  const cyclic = structuredClone(valid); cyclic.checks[0].evidence.self = cyclic.checks[0].evidence;
  await assert.rejects(validatePreflightReviewReport(cyclic), TypeError);
  const buffered = structuredClone(valid); buffered.checks[0].evidence.bytes = new Uint8Array([1]);
  await assert.rejects(validatePreflightReviewReport(buffered), TypeError);
});

test('R08 browser contract enforces evidence depth, item, byte, and limitation bounds', async () => {
  const valid = report();
  const deeplyNested = {}; let cursor = deeplyNested;
  for (let index = 0; index < 9; index += 1) { cursor.next = {}; cursor = cursor.next; }
  const deepChecks = structuredClone(valid.checks); deepChecks[0].evidence = deeplyNested;
  await assert.rejects(validatePreflightReviewReport(signed(valid, { checks: deepChecks })), TypeError);

  const itemChecks = structuredClone(valid.checks); itemChecks[0].evidence = Array.from({ length: 4_097 }, () => 1);
  await assert.rejects(validatePreflightReviewReport(signed(valid, { checks: itemChecks })), TypeError);
  const byteChecks = structuredClone(valid.checks); byteChecks[0].evidence = { text: 'x'.repeat(128 * 1024) };
  await assert.rejects(validatePreflightReviewReport(signed(valid, { checks: byteChecks })), TypeError);
  await assert.rejects(validatePreflightReviewReport(signed(valid, { limitations: ['x'.repeat(8_193)] })), TypeError);
});

test('R08 prepress client validates requests and only validates preflight responses', async () => {
  const calls = [];
  const endpoints = createPrepressEndpoints({
    json: async (_path, options) => {
      const request = JSON.parse(options.body); calls.push(request);
      return { result: request.operation === 'preflight' ? report(request.profile ?? 'print-review') : { kind: 'separation-preview' } };
    },
  });
  const preflight = await endpoints.runPrepress('document', 'preflight', { profile: 'archive-review' });
  assert.equal(preflight.profile.id, 'archive-review'); assert(Object.isFrozen(preflight));
  assert.deepEqual(await endpoints.runPrepress('document', 'separations', { page: 1 }), { kind: 'separation-preview' });
  assert.throws(() => endpoints.runPrepress('document', 'preflight', { profile: 'custom' }), TypeError);
  assert.throws(() => endpoints.runPrepress('document', 'preflight', { dpi: 144 }), TypeError);
  assert.equal(calls.length, 2);

  const mismatched = createPrepressEndpoints({ json: async () => ({ result: report('archive-review') }) });
  await assert.rejects(mismatched.runPrepress('document', 'preflight', { profile: 'print-review' }), TypeError);
});
