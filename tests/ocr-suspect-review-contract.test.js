import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OCR_SUSPECT_REVIEW_EXPORT_PROFILE,
  canonicalOcrSuspectReviewJson,
  createOcrSuspectReviewExport,
  ocrSuspectDigest,
  validateOcrSuspectReviewExport,
} from '../src/core/ocr-suspect-review-contract.js';

const digest = 'a'.repeat(64);
const suspect = (text = 'unclear', page = 1) => ({ page, text, confidence: 61.5, left: 12, top: 24, width: 36, height: 18 });
async function input(suspects = [suspect()]) {
  const reviewDecisions = Object.fromEntries(await Promise.all(suspects.map(async (entry, index) => [await ocrSuspectDigest(entry), index ? 'false-positive' : 'confirmed-low-confidence'])));
  return { sourceDigest: digest, artifact: { id: 'artifact-1', sha256: 'b'.repeat(64) }, ocr: { language: 'eng', cleanupPreset: 'document', segmentation: 'auto', pageCount: 2, suspects }, reviewDecisions };
}

test('OCR suspect review export supports 0, 1, and 500 ordered suspects', async () => {
  for (const suspects of [[], [suspect()], Array.from({ length: 500 }, (_, index) => suspect(`word-${index}`, index % 2 + 1))]) {
    const report = await createOcrSuspectReviewExport(await input(suspects));
    assert.equal(report.profile, OCR_SUSPECT_REVIEW_EXPORT_PROFILE); assert.equal(report.entries.length, suspects.length);
    assert.equal(report.counts.suspects, suspects.length); assert.deepEqual(await validateOcrSuspectReviewExport(report), report);
  }
  await assert.rejects(createOcrSuspectReviewExport(await input(Array.from({ length: 501 }, (_, index) => suspect(`word-${index}`)))), /parameters are invalid/u);
});

test('OCR suspect inventory and report digests are deterministic and order-sensitive', async () => {
  const first = await createOcrSuspectReviewExport(await input([suspect('first'), suspect('second')]));
  const repeated = await createOcrSuspectReviewExport(await input([suspect('first'), suspect('second')]));
  const reversed = await createOcrSuspectReviewExport(await input([suspect('second'), suspect('first')]));
  assert.equal(first.inventorySha256, repeated.inventorySha256); assert.equal(first.reportSha256, repeated.reportSha256);
  assert.notEqual(first.inventorySha256, reversed.inventorySha256); assert.notEqual(first.reportSha256, reversed.reportSha256);
});

test('OCR suspect report bounds the canonical bytes used for download', async () => {
  const suspects = Array.from({ length: 500 }, (_, index) => ({
    ...suspect(`${index}-${'😀'.repeat(2006)}`), left: index,
  }));
  const report = await createOcrSuspectReviewExport(await input(suspects));
  const encoder = new TextEncoder();
  assert.ok(encoder.encode(canonicalOcrSuspectReviewJson(report)).byteLength <= 4 * 1024 * 1024);
  assert.ok(encoder.encode(JSON.stringify(report, null, 2)).byteLength > 4 * 1024 * 1024);
});

test('OCR suspect export snapshots mutable input and deeply freezes output', async () => {
  const request = await input([suspect('snapshot')]); const pending = createOcrSuspectReviewExport(request);
  request.ocr.suspects[0].text = 'mutated'; request.reviewDecisions = {};
  const report = await pending;
  assert.equal(report.entries[0].text, 'snapshot'); assert.equal(Object.isFrozen(report.entries), true); assert.equal(Object.isFrozen(report.entries[0]), true);
  assert.throws(() => { report.entries[0].text = 'nope'; }, TypeError);
});

test('OCR suspect export rejects invalid bindings, unsafe keys, data, decisions, and tampering', async () => {
  const valid = await input();
  const invalids = [
    { ...valid, extra: true }, { ...valid, sourceDigest: 'A'.repeat(64) }, { ...valid, artifact: { ...valid.artifact, extra: true } },
    { ...valid, ocr: { ...valid.ocr, language: 'EN' } }, { ...valid, ocr: { ...valid.ocr, suspects: [{ ...suspect(), page: 3 }] } },
    { ...valid, ocr: { ...valid.ocr, suspects: [{ ...suspect(), confidence: 101 }] } }, { ...valid, ocr: { ...valid.ocr, suspects: [{ ...suspect(), width: -1 }] } },
    { ...valid, ocr: { ...valid.ocr, suspects: [{ ...suspect(), text: '' }] } }, { ...valid, reviewDecisions: {} },
    { ...valid, reviewDecisions: { ...valid.reviewDecisions, ['c'.repeat(64)]: 'unreviewed' } },
    { ...valid, reviewDecisions: Object.fromEntries(Object.keys(valid.reviewDecisions).map((key) => [key, 'corrected'])) },
  ];
  for (const candidate of invalids) await assert.rejects(createOcrSuspectReviewExport(candidate), TypeError);
  const report = await createOcrSuspectReviewExport(valid);
  for (const candidate of [
    { ...report, extra: true }, { ...report, reportSha256: 'c'.repeat(64) },
    { ...report, entries: [{ ...report.entries[0], text: 'tampered' }] },
    { ...report, inventorySha256: 'c'.repeat(64) }, { ...report, claims: { ...report.claims, authoritativeText: true } },
    { ...report, entries: [{ ...report.entries[0] }, { ...report.entries[0], id: 'ocr-suspect-copy' }] },
  ]) await assert.rejects(validateOcrSuspectReviewExport(candidate), TypeError);
});
