import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPdfdetachExtractArgs,
  buildPdfimagesExtractArgs,
  buildPdfimagesListStdinArgs,
  buildPdfinfoArgs,
  buildPdfinfoBoxesArgs,
  buildPdfinfoCustomMetadataArgs,
  buildPdfinfoDestinationsArgs,
  buildPdfinfoMetadataArgs,
  buildPdfinfoPageArgs,
  buildPdfinfoPageStdinArgs,
  buildPdfinfoStdinArgs,
  buildPdfinfoStructureArgs,
  buildPdfinfoUrlsArgs,
  buildPdfsigArgs,
  buildPdfsigDumpArgs,
  buildPdftocairoArgs,
  buildPdftocairoCropBoxArgs,
  buildPdftocairoOverlayExactDpiArgs,
  buildPdftotextArgs,
  buildPdftotextStdinArgs,
  buildPdftotextRegionArgs,
  buildPdfseparateArgs,
  buildPdfuniteArgs,
  PopplerAdapter,
} from '../scripts/host/adapters/poppler.mjs';

test('Poppler builders produce exact fixed argv without shell fragments', () => {
  assert.deepEqual(
    buildPdfsigDumpArgs({ input: '/tmp/input.pdf', nssDirectory: '/tmp/nss' }),
    ['-nssdir', 'sql:/tmp/nss', '-nocert', '-no-ocsp', '-dump', '/tmp/input.pdf'],
  );
  assert.deepEqual(buildPdfinfoArgs({ input: '/tmp/file name.pdf' }), ['-isodates', '/tmp/file name.pdf']);
  assert.deepEqual(buildPdfinfoStdinArgs(), ['-isodates', '-']);
  assert.deepEqual(
    buildPdfinfoPageArgs({ input: '/tmp/input.pdf', page: 3 }),
    ['-f', '3', '-l', '3', '-box', '-isodates', '/tmp/input.pdf'],
  );
  assert.deepEqual(
    buildPdfinfoPageStdinArgs({ page: 3 }),
    ['-f', '3', '-l', '3', '-box', '-isodates', '-'],
  );
  assert.deepEqual(
    buildPdfinfoBoxesArgs({ input: '/tmp/input.pdf', firstPage: 2, lastPage: 4 }),
    ['-f', '2', '-l', '4', '-box', '-isodates', '/tmp/input.pdf'],
  );
  assert.deepEqual(buildPdfinfoMetadataArgs({ input: '/tmp/input.pdf' }), ['-meta', '/tmp/input.pdf']);
  assert.deepEqual(
    buildPdfinfoCustomMetadataArgs({ input: '/tmp/input.pdf' }),
    ['-custom', '-isodates', '/tmp/input.pdf'],
  );
  assert.deepEqual(
    buildPdfinfoDestinationsArgs({ input: '/tmp/input.pdf' }),
    ['-dests', '-enc', 'UTF-8', '/tmp/input.pdf'],
  );
  assert.deepEqual(
    buildPdfinfoUrlsArgs({ input: '/tmp/input.pdf' }),
    ['-url', '-enc', 'UTF-8', '/tmp/input.pdf'],
  );
  assert.deepEqual(
    buildPdfinfoStructureArgs({ input: '/tmp/input.pdf', includeText: true }),
    ['-struct-text', '-enc', 'UTF-8', '/tmp/input.pdf'],
  );
  assert.deepEqual(
    buildPdftotextArgs({ input: '/tmp/input.pdf' }),
    ['-enc', 'UTF-8', '-layout', '/tmp/input.pdf', '-'],
  );
  assert.deepEqual(
    buildPdftotextStdinArgs(),
    ['-enc', 'UTF-8', '-layout', '-', '-'],
  );
  assert.deepEqual(
    buildPdftotextRegionArgs({ input: '/tmp/input.pdf', page: 2, region: { x: 10, y: 20, width: 300, height: 80 } }),
    ['-f', '2', '-l', '2', '-r', '72', '-x', '10', '-y', '20', '-W', '300', '-H', '80', '-cropbox', '-enc', 'UTF-8', '/tmp/input.pdf', '-'],
  );
  assert.deepEqual(
    buildPdftocairoArgs({ input: '/tmp/input.pdf', outputPrefix: '/tmp/page', page: 3, maxDimension: 2400 }),
    ['-png', '-singlefile', '-f', '3', '-l', '3', '-scale-to', '2400', '/tmp/input.pdf', '/tmp/page'],
  );
  assert.deepEqual(
    buildPdftocairoCropBoxArgs({ input: '/tmp/input.pdf', outputPrefix: '/tmp/cropbox-page', page: 3, maxDimension: 2304 }),
    ['-png', '-singlefile', '-cropbox', '-f', '3', '-l', '3', '-scale-to', '2304', '/tmp/input.pdf', '/tmp/cropbox-page'],
  );
  assert.deepEqual(
    buildPdftocairoOverlayExactDpiArgs({ input: '/tmp/input.pdf', outputPrefix: '/tmp/overlay', page: 3, dpi: 72 }),
    ['-png', '-singlefile', '-f', '3', '-l', '3', '-r', '72', '/tmp/input.pdf', '/tmp/overlay'],
  );
  assert.deepEqual(
    buildPdfimagesExtractArgs({ input: '/tmp/input.pdf', outputPrefix: '/tmp/image' }),
    ['-all', '/tmp/input.pdf', '/tmp/image'],
  );
  assert.deepEqual(buildPdfimagesListStdinArgs(), ['-list', '-']);
  assert.deepEqual(
    buildPdfdetachExtractArgs({ input: '/tmp/input.pdf', attachment: 2, output: '/tmp/file.bin' }),
    ['-save', '2', '-o', '/tmp/file.bin', '/tmp/input.pdf'],
  );
  assert.deepEqual(
    buildPdfsigArgs({ input: '/tmp/signed.pdf', nssDirectory: '/tmp/signature-job' }),
    ['-nssdir', 'sql:/tmp/signature-job', '-nocert', '-no-ocsp', '/tmp/signed.pdf'],
  );
  assert.deepEqual(
    buildPdfseparateArgs({ input: '/tmp/input.pdf', outputPattern: '/tmp/page-%d.pdf', firstPage: 2, lastPage: 4 }),
    ['-f', '2', '-l', '4', '/tmp/input.pdf', '/tmp/page-%d.pdf'],
  );
  assert.deepEqual(
    buildPdfuniteArgs({ inputs: ['/tmp/a.pdf', '/tmp/b.pdf'], output: '/tmp/out.pdf' }),
    ['/tmp/a.pdf', '/tmp/b.pdf', '/tmp/out.pdf'],
  );
});

test('Poppler builders reject path escapes, unsafe patterns, and unbounded values', () => {
  assert.throws(() => buildPdfinfoArgs({ input: 'relative.pdf' }), /absolute path/);
  assert.throws(() => buildPdfinfoPageStdinArgs({ page: 0 }), /page must be/);
  assert.throws(() => buildPdftotextStdinArgs({ layout: 'yes' }), /layout must be/);
  assert.throws(() => buildPdfinfoArgs({ input: '/tmp/bad\0.pdf' }), /NUL/);
  assert.throws(
    () => buildPdfseparateArgs({ input: '/tmp/in.pdf', outputPattern: '/tmp/page.pdf', firstPage: 1, lastPage: 2 }),
    /exactly one %d/,
  );
  assert.throws(
    () => buildPdftocairoArgs({ input: '/tmp/in.pdf', outputPrefix: '/tmp/out', page: 0 }),
    /page must be/,
  );
  assert.throws(
    () => buildPdftocairoArgs({ input: '/tmp/in.pdf', outputPrefix: '/tmp/out', page: 1, maxDimension: 20_000 }),
    /maxDimension must be/,
  );
  assert.throws(
    () => buildPdftocairoCropBoxArgs({ input: '/tmp/in.pdf', outputPrefix: '/tmp/out', page: 1, maxDimension: 2_881 }),
    /maxDimension must be/,
  );
  assert.throws(
    () => buildPdftocairoOverlayExactDpiArgs({ input: '/tmp/in.pdf', outputPrefix: '/tmp/out', page: 1, dpi: 35 }),
    /dpi must be/,
  );
  assert.throws(
    () => buildPdfuniteArgs({ inputs: ['/tmp/a.pdf', '/tmp/b.pdf'], output: '/tmp/a.pdf' }),
    /must not replace/,
  );
  assert.throws(
    () => buildPdftotextRegionArgs({ input: '/tmp/in.pdf', page: 1, region: { x: 0, y: 0, width: 0, height: 20 } }),
    /region.width/,
  );
  assert.throws(
    () => buildPdfsigArgs({ input: '/tmp/in.pdf', nssDirectory: 'relative' }),
    /nssDirectory must be an absolute path/,
  );
});

test('adapter resolves the fixed tool and forwards only a validated invocation', async () => {
  const probes = [];
  const calls = [];
  const adapter = new PopplerAdapter({
    registry: { probe: async (name) => { probes.push(name); return { executable: `/engines/${name}` }; } },
    runner: async (invocation) => { calls.push(invocation); return { stdout: 'ok', stderr: '', exitCode: 0 }; },
  });
  const result = await adapter.execute('verifySignatures', {
    input: '/tmp/signed.pdf', nssDirectory: '/tmp/signature-job',
  }, {
    timeoutMs: 2_000,
    executable: '/untrusted/override',
    args: ['--unsafe'],
  });
  assert.equal(result.stdout, 'ok');
  assert.deepEqual(probes, ['pdfsig']);
  assert.deepEqual(calls, [{
    executable: '/engines/pdfsig',
    args: ['-nssdir', 'sql:/tmp/signature-job', '-nocert', '-no-ocsp', '/tmp/signed.pdf'],
    timeoutMs: 2_000,
  }]);
  await adapter.execute('renderOverlayExactDpiPng', {
    input: '/tmp/input.pdf', outputPrefix: '/tmp/overlay', page: 3, dpi: 72,
  }, { timeoutMs: 2_000 });
  assert.deepEqual(probes, ['pdfsig', 'pdftocairo']);
  assert.deepEqual(calls[1], {
    executable: '/engines/pdftocairo',
    args: ['-png', '-singlefile', '-f', '3', '-l', '3', '-r', '72', '/tmp/input.pdf', '/tmp/overlay'],
    timeoutMs: 2_000,
  });
  await assert.rejects(() => adapter.execute('unknown', {}), /Unknown Poppler operation/);
  for (const operation of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(() => adapter.execute(operation, {}), /Unknown Poppler operation/);
  }
  assert.deepEqual(probes, ['pdfsig', 'pdftocairo']);
  assert.equal(calls.length, 2);
});
