import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildImageMagickPngStdinToPdfArgs,
  buildImageMagickRasterToPdfArgs,
  buildImageMagickTiffPreviewArgs,
  buildImageMagickTransformRasterArgs,
  ImageMagickAdapter,
} from '../scripts/host/adapters/imagemagick.mjs';

const workspace = '/jobs/private';

test('ImageMagick builders construct bounded raster-only local argv', () => {
  assert.deepEqual(buildImageMagickRasterToPdfArgs({ input: '/documents/photo.png', output: `${workspace}/photo.pdf`, workspace }), [
    '-limit', 'memory', '128MiB', '-limit', 'map', '128MiB', '-limit', 'disk', '256MiB', '-limit', 'area', '32MP', '-limit', 'width', '8192', '-limit', 'height', '8192', '-limit', 'thread', '1', '-limit', 'time', '60',
    '-define', 'registry:temporary-path=/jobs/private', 'png:/documents/photo.png', '-strip', 'pdf:/jobs/private/photo.pdf',
  ]);
  assert.deepEqual(buildImageMagickRasterToPdfArgs({ input: '/documents/photo.jpg', output: `${workspace}/photo.pdf`, workspace }), [
    '-limit', 'memory', '128MiB', '-limit', 'map', '128MiB', '-limit', 'disk', '256MiB', '-limit', 'area', '32MP', '-limit', 'width', '8192', '-limit', 'height', '8192', '-limit', 'thread', '1', '-limit', 'time', '60',
    '-define', 'registry:temporary-path=/jobs/private', '/documents/photo.jpg', '-strip', 'pdf:/jobs/private/photo.pdf',
  ]);
  assert.deepEqual(buildImageMagickPngStdinToPdfArgs({ output: `${workspace}/stdin.pdf`, workspace }), [
    '-limit', 'memory', '128MiB', '-limit', 'map', '128MiB', '-limit', 'disk', '256MiB', '-limit', 'area', '32MP', '-limit', 'width', '8192', '-limit', 'height', '8192', '-limit', 'thread', '1', '-limit', 'time', '60',
    '-define', 'registry:temporary-path=/jobs/private', 'png:-', '-strip', 'pdf:/jobs/private/stdin.pdf',
  ]);
  assert.deepEqual(buildImageMagickTransformRasterArgs({ input: '/documents/photo.jpg', output: `${workspace}/thumbnail.webp`, workspace, maxDimension: 1600, rotateDegrees: 90 }), [
    '-define', 'registry:temporary-path=/jobs/private', '/documents/photo.jpg', '-auto-orient', '-strip', '-resize', '1600x1600>', '-rotate', '90', '/jobs/private/thumbnail.webp',
  ]);
  assert.deepEqual(buildImageMagickTiffPreviewArgs({ input: `${workspace}/plate.tif`, output: `${workspace}/plate.png`, workspace, maxDimension: 4096 }), [
    '-limit', 'memory', '128MiB', '-limit', 'map', '128MiB', '-limit', 'disk', '256MiB', '-limit', 'area', '32MP', '-limit', 'thread', '1', '-limit', 'time', '60',
    '-define', 'registry:temporary-path=/jobs/private', 'tiff:/jobs/private/plate.tif', '-strip', '-resize', '4096x4096>', 'png:/jobs/private/plate.png',
  ]);
});

test('ImageMagick builders reject non-raster paths, workspace escapes, and unsafe dimensions', () => {
  assert.throws(() => buildImageMagickRasterToPdfArgs({ input: '/documents/source.pdf', output: `${workspace}/out.pdf`, workspace }), /supported raster image extension/);
  assert.throws(() => buildImageMagickRasterToPdfArgs({ input: '/documents/image.webp', output: `${workspace}/out.pdf`, workspace }), /supported raster image extension/);
  assert.throws(() => buildImageMagickPngStdinToPdfArgs({ output: '/tmp/out.pdf', workspace }), /inside workspace/);
  assert.throws(() => buildImageMagickTransformRasterArgs({ input: '/documents/photo.png', output: '/tmp/out.png', workspace, maxDimension: 400 }), /inside workspace/);
  assert.throws(() => buildImageMagickTransformRasterArgs({ input: '/documents/photo.png', output: `${workspace}/out.png`, workspace, maxDimension: 10 }), /maxDimension/);
  assert.throws(() => buildImageMagickTransformRasterArgs({ input: '/documents/photo.png', output: `${workspace}/out.png`, workspace, maxDimension: 400, rotateDegrees: '90 -write /tmp/pwn' }), /rotateDegrees/);
  assert.throws(() => buildImageMagickTiffPreviewArgs({ input: '/tmp/plate.tif', output: `${workspace}/out.png`, workspace, maxDimension: 400 }), /input must be a file inside workspace/);
});

test('ImageMagick adapter pins magick, workspace cwd, and validated argv', async () => {
  const calls = [];
  const adapter = new ImageMagickAdapter({
    registry: { probe: async (name) => ({ name, executable: '/engines/magick' }) },
    runner: async (invocation) => { calls.push(invocation); return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  await adapter.execute('convertRasterToPdf', { input: '/documents/photo.png', output: `${workspace}/out.pdf`, workspace }, {
    timeoutMs: 5_000, executable: '/untrusted', args: ['--unsafe'], cwd: '/tmp',
  });
  assert.deepEqual(calls, [{
    timeoutMs: 5_000, executable: '/engines/magick', cwd: workspace,
    args: ['-limit', 'memory', '128MiB', '-limit', 'map', '128MiB', '-limit', 'disk', '256MiB', '-limit', 'area', '32MP', '-limit', 'width', '8192', '-limit', 'height', '8192', '-limit', 'thread', '1', '-limit', 'time', '60', '-define', 'registry:temporary-path=/jobs/private', 'png:/documents/photo.png', '-strip', 'pdf:/jobs/private/out.pdf'],
  }]);
  for (const operation of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(adapter.execute(operation, {}), /Unknown ImageMagick operation/);
  }
  assert.equal(calls.length, 1);
});
