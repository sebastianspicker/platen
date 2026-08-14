import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { loadVeraPdfBundle, VERAPDF_SUPPORTED_VERSION } from '../scripts/host/verapdf-bundle-loader.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verapdf-bundle-'));
  const files = { 'bin/verapdf': Buffer.from('#!/bin/sh\nexit 0\n'), 'lib/verapdf.jar': Buffer.from('jar'), 'profiles/PDFUA-1.xml': Buffer.from('profile') };
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { mode: path === 'bin/verapdf' ? 0o555 : 0o444 }); await chmod(target, path === 'bin/verapdf' ? 0o555 : 0o444);
  }
  await writeFile(join(root, 'verapdf-bundle.json'), JSON.stringify({ schema: 'verapdf-bundle-v1', version: VERAPDF_SUPPORTED_VERSION, launcher: 'bin/verapdf', files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, digest(bytes)])) }), { mode: 0o444 });
  await chmod(join(root, 'verapdf-bundle.json'), 0o444);
  await Promise.all(['bin', 'lib', 'profiles'].map((name) => chmod(join(root, name), 0o555)));
  await chmod(root, 0o555);
  return { root, files };
}

test('veraPDF loader admits only an exact digest-pinned local bundle descriptor', async () => {
  const { root } = await fixture();
  const descriptor = await loadVeraPdfBundle({ root });
  assert.equal(descriptor.version, VERAPDF_SUPPORTED_VERSION);
  assert.equal(descriptor.launcher, join(await realpath(root), 'bin/verapdf'));
  assert.equal(descriptor.profileMap['pdfua-2'], 'ua2');
  assert.equal(descriptor.evidence.componentCount, 3);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(await loadVeraPdfBundle({ root: `${root}/missing` }), null);
});

test('veraPDF loader fails closed for changed, linked, writable, or unexpected bundle components', async () => {
  let setup = await fixture();
  await chmod(join(setup.root, 'lib/verapdf.jar'), 0o644);
  await assert.rejects(loadVeraPdfBundle({ root: setup.root }), /Invalid veraPDF bundle/);
  setup = await fixture();
  await chmod(join(setup.root, 'lib'), 0o755); await symlink('/tmp', join(setup.root, 'lib/escape')); await chmod(join(setup.root, 'lib'), 0o555);
  await assert.rejects(loadVeraPdfBundle({ root: setup.root }), /Invalid veraPDF bundle/);
  setup = await fixture();
  await chmod(join(setup.root, 'lib'), 0o755); await link(join(setup.root, 'lib/verapdf.jar'), join(setup.root, 'lib/duplicate.jar')); await chmod(join(setup.root, 'lib'), 0o555);
  await assert.rejects(loadVeraPdfBundle({ root: setup.root }), /Invalid veraPDF bundle/);
  setup = await fixture();
  await chmod(setup.root, 0o755); await writeFile(join(setup.root, 'unexpected.txt'), 'no', { mode: 0o444 }); await chmod(setup.root, 0o555);
  await assert.rejects(loadVeraPdfBundle({ root: setup.root }), /Invalid veraPDF bundle/);
  setup = await fixture();
  await chmod(join(setup.root, 'profiles'), 0o755);
  await assert.rejects(loadVeraPdfBundle({ root: setup.root }), /Invalid veraPDF bundle/);
});
