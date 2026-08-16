import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOcrImageCleanupArgs, buildOcrImageCropArgs, OcrImageAdapter } from '../scripts/host/adapters/ocr-image.mjs';
const base = { input: '/jobs/private/page.png', output: '/jobs/private/clean.png', workspace: '/jobs/private', imageWidth: 1000, imageHeight: 500 };
test('OCR image adapter builds fixed cleanup and normalized crop argv', () => {
  assert.deepEqual(buildOcrImageCleanupArgs({ ...base, dpi: 300, preset: 'document' }), ['-define', 'registry:temporary-path=/jobs/private', '/jobs/private/page.png', '-units', 'PixelsPerInch', '-density', '300', '-alpha', 'off', '-colorspace', 'Gray', '-deskew', '40%', '-despeckle', '-auto-level', '-gravity', 'center', '-extent', '1000x500', '+repage', '/jobs/private/clean.png']);
  assert.deepEqual(buildOcrImageCropArgs({ ...base, imageWidth: 1000, imageHeight: 500, region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, preset: 'none' }).slice(-4), ['-crop', '500x200+100+100', '+repage', '/jobs/private/clean.png']);
});
test('OCR image adapter rejects path, preset, and bounds injection', () => {
  assert.throws(() => buildOcrImageCleanupArgs({ ...base, output: '/tmp/out.png' }), /inside workspace/); assert.throws(() => buildOcrImageCleanupArgs({ ...base, preset: 'document; -write x' }), /preset/); assert.throws(() => buildOcrImageCropArgs({ ...base, region: { x: 0.9, y: 0, width: 0.2, height: 1 } }), /inside the image/); assert.throws(() => buildOcrImageCropArgs({ ...base, region: { x: 0, y: 0, width: 0.001, height: 1 } }), /at least 16/);
});
test('OCR image adapter pins ImageMagick executable and operation names', async () => { const calls = []; const adapter = new OcrImageAdapter({ registry: { probe: async () => ({ executable: '/engines/magick' }) }, runner: async (call) => { calls.push(call); return {}; } }); await adapter.execute('cleanup', base); assert.equal(calls[0].executable, '/engines/magick'); await assert.rejects(adapter.execute('evil', base), TypeError); for (const operation of ['toString', 'constructor', '__proto__']) await assert.rejects(adapter.execute(operation, base), TypeError); assert.equal(calls.length, 1); });
