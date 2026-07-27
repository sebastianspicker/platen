import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { documentId, fixture, mutation, mutationOptions, sourceBytes, sourceDigest } from './support/pdfkit-mutation-service-fixtures.js';
test('PDFKit outline authoring promotes one source-bound bookmark without disclosing its label', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const bookmark = { bookmark: { page: 2, label: 'Private appendix' } };
  const result = await setup.service.mutate(documentId, bookmark, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-outline-v1',
  });
  assert.equal(result.kind, 'pdfkit-outline-bookmark-mutation');
  assert.equal(result.artifact.displayName, 'source-bookmarked.pdf');
  assert.equal(result.postflight.category, 'outline-bookmark');
  assert.equal(result.evidence.priorOutlineTreeVerified, true);
  assert.equal(result.evidence.pageGeometryVerified, true);
  const state = setup.state();
  assert.equal(state.observed.request.operation, 'appendOutlineBookmark');
  assert.equal(state.observed.request.sourceSha256, sourceDigest);
  assert.deepEqual(state.observed.request.bookmark, bookmark.bookmark);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'outline-bookmark', targetPage: 2,
  });
  assert.doesNotMatch(JSON.stringify(result), /Private appendix/u);
});

test('PDFKit outline authoring rejects unsafe labels and mismatched preservation receipts', async (context) => {
  const options = { sourceSha256: sourceDigest, profile: 'macos-pdfkit-outline-v1' };
  const valid = { bookmark: { page: 1, label: 'Chapter one' } };
  const setup = await fixture(); context.after(setup.dispose);
  for (const input of [
    { ...valid, action: 'GoTo' },
    { bookmark: { ...valid.bookmark, page: 3 } },
    { bookmark: { ...valid.bookmark, label: '' } },
    { bookmark: { ...valid.bookmark, label: 'unsafe\u202E' } },
  ]) {
    await assert.rejects(setup.service.mutate(documentId, input, options), {
      code: 'INVALID_PDFKIT_MUTATION', status: 400,
    });
  }
  assert.equal(setup.state().observed, null);

  for (const outlineReceiptOverride of [
    { page: 2 },
    { labelSha256: '0'.repeat(64) },
    { priorOutlineTreeVerified: false },
    { pageGeometryVerified: false },
    { rawDestinationVerified: false },
  ]) {
    const mismatched = await fixture({ outlineReceiptOverride });
    context.after(mismatched.dispose);
    await assert.rejects(mismatched.service.mutate(documentId, valid, options), {
      code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
    });
    assert.equal(mismatched.state().promoted, null);
  }
});

test('PDFKit outline removal promotes one opaque source-bound leaf locator', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const fingerprint = 'e'.repeat(64);
  const mutation = { bookmarkRemoval: { topLevelIndex: 0, fingerprint } };
  const result = await setup.service.mutate(documentId, mutation, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-outline-remove-v1',
  });
  assert.equal(result.kind, 'pdfkit-outline-bookmark-removal');
  assert.equal(result.artifact.displayName, 'source-bookmark-removed.pdf');
  assert.equal(result.postflight.category, 'outline-bookmark-removal');
  assert.equal(result.evidence.outlineRemoved, true);
  assert.equal(result.evidence.remainingOutlineTreeVerified, true);
  assert.equal(result.evidence.contentSnapshotVerified, true);
  const state = setup.state();
  assert.equal(state.observed.request.operation, 'removeOutlineBookmark');
  assert.equal(state.observed.request.sourceSha256, sourceDigest);
  assert.deepEqual(state.observed.request.bookmark, mutation.bookmarkRemoval);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'outline-bookmark-removal', topLevelIndex: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fingerprint, 'u'));
});

test('PDFKit outline removal rejects malformed locators and mismatched delta receipts', async (context) => {
  const fingerprint = 'e'.repeat(64);
  const valid = { bookmarkRemoval: { topLevelIndex: 0, fingerprint } };
  const options = {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-outline-remove-v1',
  };
  const setup = await fixture(); context.after(setup.dispose);
  for (const input of [
    { ...valid, label: 'spoof' },
    { bookmarkRemoval: { ...valid.bookmarkRemoval, topLevelIndex: -1 } },
    { bookmarkRemoval: { ...valid.bookmarkRemoval, topLevelIndex: 200 } },
    { bookmarkRemoval: { ...valid.bookmarkRemoval, fingerprint: 'E'.repeat(64) } },
  ]) {
    await assert.rejects(setup.service.mutate(documentId, input, options), {
      code: 'INVALID_PDFKIT_MUTATION', status: 400,
    });
  }
  assert.equal(setup.state().observed, null);

  for (const outlineRemovalReceiptOverride of [
    { topLevelIndex: 1 },
    { outputSha256: '0'.repeat(64) },
    { rawTargetVerified: false },
    { outlineRemoved: false },
    { remainingOutlineTreeVerified: false },
    { pageGeometryVerified: false },
    { annotationInventoryVerified: false },
    { contentSnapshotVerified: false },
    { reopenVerified: false },
  ]) {
    const mismatched = await fixture({ outlineRemovalReceiptOverride });
    context.after(mismatched.dispose);
    await assert.rejects(mismatched.service.mutate(documentId, valid, options), {
      code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
    });
    assert.equal(mismatched.state().promoted, null);
  }
});

test('PDFKit outline rename promotes one source-bound rename without disclosing label or locator', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const fingerprint = 'e'.repeat(64);
  const mutation = { bookmarkRename: { topLevelIndex: 0, fingerprint, label: 'Renamed appendix' } };
  const result = await setup.service.mutate(documentId, mutation, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-outline-rename-v1',
  });
  assert.equal(result.kind, 'pdfkit-outline-bookmark-rename');
  assert.equal(result.artifact.displayName, 'source-bookmark-renamed.pdf');
  assert.equal(result.postflight.category, 'outline-bookmark-rename');
  assert.equal(result.evidence.outlineRenamed, true);
  assert.equal(result.evidence.remainingOutlineTreeVerified, true);
  const state = setup.state();
  assert.equal(state.observed.request.operation, 'renameOutlineBookmark');
  assert.equal(state.observed.request.sourceSha256, sourceDigest);
  assert.deepEqual(state.observed.request.bookmarkRename, mutation.bookmarkRename);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'outline-bookmark-rename', topLevelIndex: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /Renamed appendix|e{64}/u);
});

test('PDFKit outline rename rejects malformed requests and mismatched compact receipts', async (context) => {
  const fingerprint = 'e'.repeat(64);
  const valid = { bookmarkRename: { topLevelIndex: 0, fingerprint, label: 'Chapter two' } };
  const options = { sourceSha256: sourceDigest, profile: 'macos-pdfkit-outline-rename-v1' };
  const setup = await fixture(); context.after(setup.dispose);
  for (const input of [
    { ...valid, bookmarkRemoval: { topLevelIndex: 0, fingerprint } },
    { bookmarkRename: { ...valid.bookmarkRename, label: 'unsafe\u202E' } },
    { bookmarkRename: { ...valid.bookmarkRename, fingerprint: 'E'.repeat(64) } },
  ]) {
    await assert.rejects(setup.service.mutate(documentId, input, options), {
      code: 'INVALID_PDFKIT_MUTATION', status: 400,
    });
  }
  assert.equal(setup.state().observed, null);

  for (const outlineRenameReceiptOverride of [
    { topLevelIndex: 1 }, { labelSha256: '0'.repeat(64) }, { outputSha256: '0'.repeat(64) },
    { rawTargetVerified: false }, { outlineRenamed: false }, { remainingOutlineTreeVerified: false },
    { pageGeometryVerified: false }, { annotationInventoryVerified: false },
    { contentSnapshotVerified: false }, { reopenVerified: false }, { label: 'must not escape' },
  ]) {
    const mismatched = await fixture({ outlineRenameReceiptOverride });
    context.after(mismatched.dispose);
    await assert.rejects(mismatched.service.mutate(documentId, valid, options), {
      code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
    });
    assert.equal(mismatched.state().promoted, null);
  }
});
