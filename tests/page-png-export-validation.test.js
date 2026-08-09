import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import {
  validatePageInspection,
  validatePagePng,
  verifyRetainedSource,
} from '../scripts/host/page-png-export-validation.mjs';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';

const png = encodeRgbaPng({
  width: 2,
  height: 3,
  pixels: Buffer.alloc(2 * 3 * 4, 128),
});

test('page PNG validator verifies dimensions, digest, media type, and page bounds', async () => {
  const checked = validatePagePng(png);
  assert.deepEqual(checked, {
    size: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
    width: 2,
    height: 3,
    mediaType: 'image/png',
  });
  assert.deepEqual(validatePageInspection({ pageCount: 3 }, 2), { pageCount: 3, page: 2 });
  await assert.rejects(() => verifyRetainedSource(null, {}), { code: 'CLI_SOURCE_VERIFY_UNAVAILABLE' });
});

test('page PNG validator rejects forged signature and CRC', () => {
  const forged = Buffer.from(png);
  forged[0] = 0;
  assert.throws(() => validatePagePng(forged), { code: 'CLI_INVALID_ENGINE_OUTPUT' });
  const corrupt = Buffer.from(png);
  corrupt[corrupt.length - 5] ^= 0xff;
  assert.throws(() => validatePagePng(corrupt), { code: 'INVALID_RENDER_OUTPUT' });
});

test('retained-source verifier rejects stale document records', async () => {
  const source = createTextPdf({ text: 'source' });
  const sha256 = createHash('sha256').update(source).digest('hex');
  const calls = [];
  const store = {
    async verifySource(id) { calls.push(id); return true; },
    getDocument(id) { return { id, mediaType: 'application/pdf', sha256: `${sha256.slice(0, -1)}0` }; },
  };
  await assert.rejects(
    () => verifyRetainedSource(store, { id: 'doc', mediaType: 'application/pdf', sha256 }),
    { code: 'CLI_SOURCE_INTEGRITY_FAILED' },
  );
  assert.deepEqual(calls, ['doc']);
});
