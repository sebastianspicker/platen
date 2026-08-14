import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EngineRegistry,
  EngineRegistryError,
  BUILTIN_EXECUTABLES,
  GHOSTSCRIPT_EXECUTABLES,
  IMAGEMAGICK_EXECUTABLES,
  LIBREOFFICE_EXECUTABLES,
  POPPLER_EXECUTABLES,
  resolveExecutable,
} from '../scripts/host/engine-registry.mjs';

test('resolver checks only fixed absolute directories and returns an executable path', async () => {
  const checked = [];
  const result = await resolveExecutable('pdfinfo', {
    directories: ['/missing', '/engines'],
    accessImpl: async (candidate) => {
      checked.push(candidate);
      if (candidate !== '/engines/pdfinfo') throw new Error('missing');
    },
  });
  assert.equal(result, '/engines/pdfinfo');
  assert.deepEqual(checked, ['/missing/pdfinfo', '/engines/pdfinfo']);
  await assert.rejects(
    resolveExecutable('pdfinfo', { directories: ['/missing'], accessImpl: async () => { throw new Error('missing'); } }),
    (error) => error instanceof EngineRegistryError && error.code === 'ENGINE_NOT_FOUND',
  );
});

test('registry uses the fixed Tesseract version probe', async () => {
  const registry = new EngineRegistry({
    resolver: async () => '/engines/tesseract',
    runner: async (invocation) => {
      assert.deepEqual(invocation.args, ['--version']);
      return { stdout: 'tesseract 5.5.2\n leptonica-1.87', stderr: '' };
    },
  });
  assert.equal(BUILTIN_EXECUTABLES.includes('tesseract'), true);
  assert.equal((await registry.probe('tesseract')).version, '5.5.2');
});

test('registry uses fixed version probes for Ghostscript, LibreOffice, and ImageMagick', async () => {
  const outputs = {
    gs: '10.05.1\n',
    soffice: 'LibreOffice 25.2.4.3\n',
    magick: 'Version: ImageMagick 7.1.1-43 Q16-HDRI\n',
  };
  const expectedArgs = { gs: ['--version'], soffice: ['--version'], magick: ['--version'] };
  const registry = new EngineRegistry({
    resolver: async (name) => `/engines/${name}`,
    runner: async ({ executable, args }) => {
      const name = executable.slice('/engines/'.length);
      assert.deepEqual(args, expectedArgs[name]);
      return { stdout: outputs[name], stderr: '' };
    },
  });
  assert.equal(GHOSTSCRIPT_EXECUTABLES.includes('gs'), true);
  assert.equal(LIBREOFFICE_EXECUTABLES.includes('soffice'), true);
  assert.equal(IMAGEMAGICK_EXECUTABLES.includes('magick'), true);
  assert.equal((await registry.probe('gs')).version, '10.05.1');
  assert.equal((await registry.probe('soffice')).version, '25.2.4.3');
  assert.equal((await registry.probe('magick')).version, '7.1.1-43');
});

test('registry probes version once and caches an immutable absolute record', async () => {
  let resolves = 0;
  let runs = 0;
  const registry = new EngineRegistry({
    resolver: async (name) => { resolves += 1; return `/engines/${name}`; },
    runner: async (invocation) => {
      runs += 1;
      assert.deepEqual(invocation.args, ['-v']);
      return { stdout: '', stderr: 'pdfinfo version 26.07.0\n' };
    },
  });
  const first = await registry.probe('pdfinfo');
  const second = await registry.probe('pdfinfo');
  assert.equal(first, second);
  assert.deepEqual(first, {
    name: 'pdfinfo', executable: '/engines/pdfinfo', version: '26.07.0', available: true,
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(resolves, 1);
  assert.equal(runs, 1);
});

test('registry deduplicates simultaneous in-flight version probes', async () => {
  let resolves = 0;
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = new EngineRegistry({
    resolver: async () => { resolves += 1; await gate; return '/engines/pdfinfo'; },
    runner: async () => { runs += 1; return { stdout: '', stderr: 'pdfinfo version 26.07.0\n' }; },
  });
  const first = registry.probe('pdfinfo');
  const second = registry.probe('pdfinfo');
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(resolves, 1);
  assert.equal(runs, 1);
});

test('registry rejects unknown tools, relative resolutions, and malformed versions', async () => {
  const relative = new EngineRegistry({ resolver: async () => 'pdfinfo', runner: async () => ({ stdout: '', stderr: '' }) });
  await assert.rejects(relative.probe('pdfinfo'), { code: 'ENGINE_PATH_INVALID' });

  const malformed = new EngineRegistry({
    resolver: async (name) => `/engines/${name}`,
    runner: async () => ({ stdout: 'unknown output', stderr: '' }),
  });
  await assert.rejects(malformed.probe('pdfinfo'), { code: 'ENGINE_VERSION_INVALID' });
  await assert.rejects(malformed.probe('ghostscript'), { code: 'ENGINE_UNKNOWN' });
  assert.equal(POPPLER_EXECUTABLES.includes('ghostscript'), false);
});

test('registry accepts Poppler utilities that report a version with their usage exit code', async () => {
  const registry = new EngineRegistry({
    resolver: async () => '/engines/pdfdetach',
    runner: async () => {
      const error = new Error('usage exit');
      error.code = 'ENGINE_PROCESS_FAILED';
      error.stderr = 'pdfdetach version 26.07.0';
      throw error;
    },
  });
  assert.deepEqual(await registry.probe('pdfdetach'), {
    name: 'pdfdetach', executable: '/engines/pdfdetach', version: '26.07.0', available: true,
  });
});
