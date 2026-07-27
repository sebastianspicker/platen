import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { stagePdfKitHelper, verifyStagedPdfKitHelper } from '../scripts/host/pdfkit-helper-loader.mjs';

const machOFixture = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('pinned helper fixture')]);

async function roots() {
  const root = await mkdtemp(join(tmpdir(), 'pdfkit-loader-project-'));
  const sessionRoot = await mkdtemp(join(tmpdir(), 'pdfkit-loader-session-'));
  await chmod(root, 0o700);
  await chmod(sessionRoot, 0o700);
  return { root, sessionRoot };
}

async function helperPath(root) {
  const path = join(root, 'native/pdfkit-helper/bin/pdfkit-inspect');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}

test('PDFKit helper loader stages and re-verifies one private digest-pinned Mach-O copy', async () => {
  const { root, sessionRoot } = await roots();
  const source = await helperPath(root);
  await writeFile(source, machOFixture, { mode: 0o755 });
  const staged = await stagePdfKitHelper({ root, sessionRoot, platform: 'darwin' });
  assert.equal(staged.available, true);
  assert.equal(staged.kind, 'packaged');
  assert.notEqual(staged.executable, source);
  assert.deepEqual(await readFile(staged.executable), machOFixture);
  assert.equal((await lstat(staged.executable)).mode & 0o777, 0o500);
  assert.equal(await verifyStagedPdfKitHelper({ executable: staged.executable, expectedSha256: staged.sha256 }), true);
  await chmod(staged.executable, 0o700);
  await writeFile(staged.executable, Buffer.concat([machOFixture, Buffer.from('tampered')]));
  await assert.rejects(verifyStagedPdfKitHelper({ executable: staged.executable, expectedSha256: staged.sha256 }));
});

test('PDFKit helper loader fails closed for missing, linked, or writable candidates', async () => {
  let fixture = await roots();
  assert.deepEqual(await stagePdfKitHelper({ ...fixture, platform: 'linux' }), { available: false, reason: 'unsupported-platform' });
  assert.deepEqual(await stagePdfKitHelper({ ...fixture, platform: 'darwin' }), { available: false, reason: 'release-helper-not-built' });

  fixture = await roots();
  let source = await helperPath(fixture.root);
  const actual = join(dirname(source), 'actual-helper');
  await writeFile(actual, machOFixture, { mode: 0o755 });
  await symlink(actual, source);
  await assert.rejects(stagePdfKitHelper({ ...fixture, platform: 'darwin' }), /Unsafe PDFKit helper/);

  fixture = await roots();
  source = await helperPath(fixture.root);
  await writeFile(source, machOFixture, { mode: 0o755 });
  await link(source, join(dirname(source), 'hardlink-helper'));
  await assert.rejects(stagePdfKitHelper({ ...fixture, platform: 'darwin' }), /Unsafe PDFKit helper/);
  await unlink(join(dirname(source), 'hardlink-helper'));
  await chmod(source, 0o775);
  await assert.rejects(stagePdfKitHelper({ ...fixture, platform: 'darwin' }), /Unsafe PDFKit helper/);

  fixture = await roots();
  const external = await mkdtemp(join(tmpdir(), 'pdfkit-loader-external-'));
  const escaped = join(external, 'bin/pdfkit-inspect');
  await mkdir(dirname(escaped), { recursive: true, mode: 0o700 });
  await writeFile(escaped, machOFixture, { mode: 0o755 });
  await mkdir(join(fixture.root, 'native'), { mode: 0o700 });
  await symlink(external, join(fixture.root, 'native/pdfkit-helper'));
  await assert.rejects(stagePdfKitHelper({ ...fixture, platform: 'darwin' }), /escaped the project root/);
});
