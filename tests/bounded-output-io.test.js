import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  openRegularOutput,
  pngDimensions,
  readRegularOutput,
  validatePngOutput,
} from '../scripts/host/bounded-output-io.mjs';
import {
  MAX_OCR_RASTER_PIXELS,
  PNG_SIGNATURE,
} from '../scripts/host/pdf-service-limits.mjs';

const require = createRequire(import.meta.url);
const fsPromises = require('node:fs/promises');
const originalFsPromises = Object.freeze({ lstat: fsPromises.lstat, open: fsPromises.open });
let patchedModuleNumber = 0;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'bounded-output-io-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function pngHeader(width, height, { signature = true, ihdr = true } = {}) {
  const header = Buffer.alloc(24);
  if (signature) PNG_SIGNATURE.copy(header);
  header.writeUInt32BE(13, 8);
  header.write(ihdr ? 'IHDR' : 'NOPE', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

async function assertInvalid(promise, message) {
  await assert.rejects(promise, (error) => error.code === 'INVALID_ENGINE_OUTPUT'
    && error.status === 502 && error.message === message);
}

async function descriptorCount(t) {
  if (process.platform === 'win32') {
    t.skip('/dev/fd is unavailable on Windows');
    return null;
  }
  return (await readdir('/dev/fd')).length;
}

function regularMetadata({ size = 5, ino = 1, nlink = 1, dev = 1, isFile = true } = {}) {
  return {
    isSymbolicLink: () => false,
    isFile: () => isFile,
    nlink,
    dev,
    ino,
    size,
    mtimeMs: 1,
    ctimeMs: 1,
  };
}

function trackedHandle({ stats = [regularMetadata()], read } = {}) {
  let closeCount = 0;
  let statCall = 0;
  return {
    closeCount: () => closeCount,
    handle: {
      stat: async () => stats[Math.min(statCall++, stats.length - 1)],
      read: read ?? (async (buffer, offset, length) => {
        buffer.fill(0x61, offset, offset + length);
        return { bytesRead: length };
      }),
      close: async () => { closeCount += 1; },
    },
  };
}

async function withPatchedOutputIo(overrides, run) {
  const original = { lstat: fsPromises.lstat, open: fsPromises.open };
  Object.assign(fsPromises, overrides);
  syncBuiltinESMExports();
  try {
    const module = await import(`../scripts/host/bounded-output-io.mjs?patched=${patchedModuleNumber += 1}`);
    return await run(module);
  } finally {
    Object.assign(fsPromises, original);
    syncBuiltinESMExports();
  }
}

test('regular output reads exact bytes and admits inclusive byte bounds', async (t) => {
  const root = await workspace(t);
  const file = join(root, 'output.bin');
  await writeFile(file, 'hello');

  assert.deepEqual(await readRegularOutput(file, {
    minimumBytes: 5,
    maximumBytes: 5,
    label: 'Engine output',
  }), Buffer.from('hello'));
  assert.deepEqual(await readRegularOutput(file, {
    label: 'Engine output',
  }), Buffer.from('hello'));

  const { handle, metadata } = await openRegularOutput(file, {
    minimumBytes: 5,
    maximumBytes: 5,
    label: 'Engine output',
  });
  assert.equal(metadata.size, 5);
  await handle.close();
});

test('regular output rejects byte bounds with its exact engine-output contract', async (t) => {
  const root = await workspace(t);
  const file = join(root, 'output.bin');
  await writeFile(file, 'hello');

  await assertInvalid(openRegularOutput(file, {
    minimumBytes: 6,
    maximumBytes: 6,
    label: 'Engine output',
  }), 'Engine output is not a bounded single-link regular file.');
  await assertInvalid(openRegularOutput(file, {
    minimumBytes: 1,
    maximumBytes: 4,
    label: 'Engine output',
  }), 'Engine output is not a bounded single-link regular file.');
});

test('regular output rejects directory and hard-link paths', async (t) => {
  const root = await workspace(t);
  const file = join(root, 'output.bin');
  const directory = join(root, 'directory');
  const hardLink = join(root, 'hard-link.bin');
  await writeFile(file, 'hello');
  await mkdir(directory);

  await assertInvalid(openRegularOutput(directory, {
    maximumBytes: 10,
    label: 'Engine output',
  }), 'Engine output is not a single-link regular file.');

  await link(file, hardLink);
  await assertInvalid(openRegularOutput(file, {
    maximumBytes: 10,
    label: 'Engine output',
  }), 'Engine output is not a single-link regular file.');
  await assertInvalid(openRegularOutput(hardLink, {
    maximumBytes: 10,
    label: 'Engine output',
  }), 'Engine output is not a single-link regular file.');
});

test('regular output rejects symbolic-link paths where links are supported', async (t) => {
  const root = await workspace(t);
  const file = join(root, 'output.bin');
  const symbolic = join(root, 'symbolic.bin');
  await writeFile(file, 'hello');
  try {
    await symlink(file, symbolic);
  } catch (error) {
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('symbolic-link privilege is unavailable on Windows');
      return;
    }
    throw error;
  }
  await assertInvalid(openRegularOutput(symbolic, {
    maximumBytes: 10,
    label: 'Engine output',
  }), 'Engine output is not a single-link regular file.');
});

test('PNG output validates the signature and returns original metadata', async (t) => {
  const root = await workspace(t);
  const file = join(root, 'output.png');
  await writeFile(file, pngHeader(1, 1));
  const metadata = await validatePngOutput(file, 24, 'Raster');
  assert.equal(metadata.size, 24);

  await writeFile(file, pngHeader(1, 1, { signature: false }));
  await assertInvalid(validatePngOutput(file, 24, 'Raster'), 'Raster output is not a PNG image.');
});

test('PNG dimensions accept valid IHDR and reject malformed or out-of-bound values', async (t) => {
  const root = await workspace(t);
  const file = join(root, 'output.png');
  await writeFile(file, pngHeader(320, 240));
  assert.deepEqual(await pngDimensions(file), { width: 320, height: 240 });

  for (const header of [
    Buffer.alloc(24),
    pngHeader(1, 1, { ihdr: false }),
    pngHeader(1, 1).subarray(0, 16),
  ]) {
    await writeFile(file, header);
    await assertInvalid(pngDimensions(file), 'OCR raster PNG header is invalid.');
  }

  const dimensionHeaders = [
    pngHeader(0, 1),
    pngHeader(1, 0),
    pngHeader(16_385, 1),
    pngHeader(1, 16_385),
    pngHeader(16_384, 6_401),
  ];
  for (const header of dimensionHeaders) {
    await writeFile(file, header);
    await assertInvalid(pngDimensions(file), 'OCR raster PNG dimensions are invalid.');
  }
  await writeFile(file, pngHeader(16_384, 6_400));
  assert.deepEqual(await pngDimensions(file), { width: 16_384, height: 6_400 });
  assert.equal(MAX_OCR_RASTER_PIXELS, 16_384 * 6_400);
});

test('output validation closes handles after success and post-open validation failures', async (t) => {
  const root = await workspace(t);
  const file = join(root, 'output.png');
  await writeFile(file, pngHeader(1, 1));
  const before = await descriptorCount(t);
  if (before === null) return;

  const { handle } = await openRegularOutput(file, { maximumBytes: 24, label: 'Engine output' });
  assert.equal((await descriptorCount(t)), before + 1);
  await handle.close();
  assert.equal(await descriptorCount(t), before);

  await assertInvalid(openRegularOutput(file, {
    maximumBytes: 23,
    label: 'Engine output',
  }), 'Engine output is not a bounded single-link regular file.');
  await writeFile(file, pngHeader(1, 1, { ihdr: false }));
  await assertInvalid(pngDimensions(file), 'OCR raster PNG header is invalid.');
  assert.equal(await descriptorCount(t), before);
  assert.equal((await lstat(file)).isFile(), true);
});

test('regular output rejects replacement between lstat and open and a hard link added after open', async (t) => {
  const root = await workspace(t);
  const file = join(root, 'output.bin');
  const hardLink = join(root, 'hard-link.bin');
  const parked = join(root, 'parked.bin');
  await writeFile(file, 'first');
  let replacementHandle;
  await withPatchedOutputIo({
    lstat: async (path) => {
      const metadata = await originalFsPromises.lstat(path);
      await rename(path, parked);
      await writeFile(path, 'second');
      return metadata;
    },
    open: async (path) => {
      replacementHandle = trackedHandle({ stats: [await originalFsPromises.lstat(path)] });
      return replacementHandle.handle;
    },
  }, async ({ openRegularOutput: openOutput }) => {
    await assertInvalid(openOutput(file, { maximumBytes: 10, label: 'Engine output' }), 'Engine output is not a bounded single-link regular file.');
  });
  assert.equal(replacementHandle.closeCount(), 1);

  const linkedHandle = trackedHandle({ stats: [regularMetadata({ nlink: 2 })] });
  await withPatchedOutputIo({
    lstat: async () => regularMetadata(),
    open: async () => {
      await link(file, hardLink);
      return linkedHandle.handle;
    },
  }, async ({ openRegularOutput: openOutput }) => {
    await assertInvalid(openOutput(file, { maximumBytes: 10, label: 'Engine output' }), 'Engine output is not a bounded single-link regular file.');
  });
  assert.equal(linkedHandle.closeCount(), 1);

  for (const metadata of [
    regularMetadata({ dev: 2 }),
    regularMetadata({ isFile: false }),
  ]) {
    const handle = trackedHandle({ stats: [metadata] });
    await withPatchedOutputIo({ lstat: async () => regularMetadata(), open: async () => handle.handle }, async ({ openRegularOutput: openOutput }) => {
      await assertInvalid(openOutput('output.bin', { maximumBytes: 5, label: 'Engine output' }), 'Engine output is not a bounded single-link regular file.');
    });
    assert.equal(handle.closeCount(), 1);
  }
});

test('regular output passes O_NOFOLLOW where supported and closes each allocated handle once', async () => {
  let flags;
  const accepted = trackedHandle();
  await withPatchedOutputIo({
    lstat: async () => regularMetadata(),
    open: async (_path, receivedFlags) => {
      flags = receivedFlags;
      return accepted.handle;
    },
  }, async ({ openRegularOutput: openOutput }) => {
    const { handle } = await openOutput('output.bin', { maximumBytes: 5, label: 'Engine output' });
    await handle.close();
  });
  if (fsConstants.O_NOFOLLOW !== undefined) assert.equal(flags & fsConstants.O_NOFOLLOW, fsConstants.O_NOFOLLOW);
  assert.equal(accepted.closeCount(), 1);

  const statFailure = trackedHandle({ stats: [undefined] });
  statFailure.handle.stat = async () => { throw null; };
  await withPatchedOutputIo({ lstat: async () => regularMetadata(), open: async () => statFailure.handle }, async ({ openRegularOutput: openOutput }) => {
    await assertInvalid(openOutput('output.bin', { maximumBytes: 5, label: 'Engine output' }), 'Engine output could not be opened safely.');
  });
  assert.equal(statFailure.closeCount(), 1);

  const boundsFailure = trackedHandle({ stats: [regularMetadata({ size: 6 })] });
  await withPatchedOutputIo({ lstat: async () => regularMetadata(), open: async () => boundsFailure.handle }, async ({ openRegularOutput: openOutput }) => {
    await assertInvalid(openOutput('output.bin', { maximumBytes: 5, label: 'Engine output' }), 'Engine output is not a bounded single-link regular file.');
  });
  assert.equal(boundsFailure.closeCount(), 1);

  await withPatchedOutputIo({ lstat: async () => { throw 42; } }, async ({ openRegularOutput: openOutput }) => {
    await assert.rejects(openOutput('output.bin', { maximumBytes: 5, label: 'Engine output' }), (error) => error.code === 'INVALID_ENGINE_OUTPUT' && error.status === 502 && error.cause === 42);
  });
  await withPatchedOutputIo({ lstat: async () => regularMetadata(), open: async () => { throw 'open failure'; } }, async ({ openRegularOutput: openOutput }) => {
    await assert.rejects(openOutput('output.bin', { maximumBytes: 5, label: 'Engine output' }), (error) => error.code === 'INVALID_ENGINE_OUTPUT' && error.status === 502 && error.cause === 'open failure');
  });
});

test('read and PNG paths close mocked handles exactly once on success and failure', async () => {
  const readSuccess = trackedHandle({ stats: [regularMetadata(), regularMetadata()] });
  await withPatchedOutputIo({ lstat: async () => regularMetadata(), open: async () => readSuccess.handle }, async ({ readRegularOutput: readOutput }) => {
    await readOutput('output.bin', { maximumBytes: 5, label: 'Engine output' });
  });
  assert.equal(readSuccess.closeCount(), 1);

  const readFailure = trackedHandle({
    read: async () => ({ bytesRead: 0 }),
  });
  await withPatchedOutputIo({ lstat: async () => regularMetadata(), open: async () => readFailure.handle }, async ({ readRegularOutput: readOutput }) => {
    await assertInvalid(readOutput('output.bin', { maximumBytes: 5, label: 'Engine output' }), 'Engine output changed while it was being read.');
  });
  assert.equal(readFailure.closeCount(), 1);

  const pngSuccess = trackedHandle({ read: async (buffer) => {
    PNG_SIGNATURE.copy(buffer);
    return { bytesRead: PNG_SIGNATURE.length };
  } });
  await withPatchedOutputIo({ lstat: async () => regularMetadata(), open: async () => pngSuccess.handle }, async ({ validatePngOutput: validate }) => {
    await validate('output.png', 5, 'Raster');
  });
  assert.equal(pngSuccess.closeCount(), 1);

  const pngFailure = trackedHandle({ read: async () => ({ bytesRead: PNG_SIGNATURE.length }) });
  await withPatchedOutputIo({ lstat: async () => regularMetadata(), open: async () => pngFailure.handle }, async ({ validatePngOutput: validate }) => {
    await assertInvalid(validate('output.png', 5, 'Raster'), 'Raster output is not a PNG image.');
  });
  assert.equal(pngFailure.closeCount(), 1);

  const headerRead = (header) => async (buffer) => {
    header.copy(buffer);
    return { bytesRead: header.length };
  };
  for (const [read, expected, message, primitive] of [
    [headerRead(pngHeader(320, 240)), { width: 320, height: 240 }],
    [async () => ({ bytesRead: 24 }), undefined, 'OCR raster PNG header is invalid.'],
    [headerRead(pngHeader(0, 1)), undefined, 'OCR raster PNG dimensions are invalid.'],
    [async () => { throw 17; }, undefined, undefined, 17],
  ]) {
    const handle = trackedHandle({ read });
    await withPatchedOutputIo({ lstat: async () => regularMetadata(), open: async () => handle.handle }, async ({ pngDimensions: dimensions }) => {
      if (expected) assert.deepEqual(await dimensions('output.png'), expected);
      else if (primitive !== undefined) await assert.rejects(dimensions('output.png'), (error) => error === primitive);
      else await assertInvalid(dimensions('output.png'), message);
    });
    assert.equal(handle.closeCount(), 1);
  }
});
