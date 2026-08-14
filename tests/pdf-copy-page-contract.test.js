import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../scripts/host/host-error.mjs';
import { PDF_COPY_PAGE_PROFILE, validateCopyPageRequest } from '../scripts/host/pdf-copy-page-contract.mjs';

const primary = { sha256: 'a'.repeat(64), pageCount: 3 };
const secondary = { sha256: 'b'.repeat(64), pageCount: 2 };
const request = () => ({ profile: PDF_COPY_PAGE_PROFILE, primarySourceSha256: primary.sha256, secondarySourceSha256: secondary.sha256, sourcePage: 2, afterPage: 1 });

test('copy-page request is exact, source-bound, and range-bound', () => {
  assert.deepEqual(validateCopyPageRequest(request(), primary, secondary), request());
  assert.throws(() => validateCopyPageRequest({ ...request(), extra: true }, primary, secondary), { code: 'INVALID_COPY_PAGE_REQUEST' });
  const drifted = request(); drifted.primarySourceSha256 = 'c'.repeat(64);
  assert.throws(() => validateCopyPageRequest(drifted, primary, secondary), { code: 'SOURCE_VERSION_MISMATCH' });
  const outOfRange = request(); outOfRange.sourcePage = 3;
  assert.throws(() => validateCopyPageRequest(outOfRange, primary, secondary), { code: 'INVALID_COPY_PAGE_REQUEST' });
  assert.throws(() => validateCopyPageRequest({ afterPage: 1, sourcePage: 2, secondarySourceSha256: secondary.sha256, primarySourceSha256: primary.sha256, profile: PDF_COPY_PAGE_PROFILE }, primary, secondary), { code: 'INVALID_COPY_PAGE_REQUEST' });
});
