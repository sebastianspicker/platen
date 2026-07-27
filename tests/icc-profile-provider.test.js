import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GhostscriptIccProfileProvider, inspectCmykOutputProfile } from '../scripts/host/icc-profile-provider.mjs';

function cmykProfile(description = 'Fixture CMYK Profile') {
  const name = Buffer.from(`${description}\0`, 'ascii');
  const tagOffset = 144;
  const tagSize = 12 + name.length;
  const bytes = Buffer.alloc(tagOffset + tagSize);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes[8] = 2; bytes[9] = 0x20;
  bytes.write('prtr', 12, 'ascii'); bytes.write('CMYK', 16, 'ascii'); bytes.write('Lab ', 20, 'ascii');
  bytes.write('acsp', 36, 'ascii'); bytes.writeUInt32BE(1, 64);
  bytes.writeUInt32BE(1, 128); bytes.write('desc', 132, 'ascii');
  bytes.writeUInt32BE(tagOffset, 136); bytes.writeUInt32BE(tagSize, 140);
  bytes.write('desc', tagOffset, 'ascii'); bytes.writeUInt32BE(name.length, tagOffset + 8); name.copy(bytes, tagOffset + 12);
  return bytes;
}

test('ICC parser accepts only bounded CMYK printer output profiles with in-range tags', () => {
  const profile = inspectCmykOutputProfile(cmykProfile());
  assert.equal(profile.description, 'Fixture CMYK Profile');
  assert.equal(profile.colorSpace, 'CMYK');
  assert.equal(profile.deviceClass, 'output');
  assert.equal(profile.renderingIntent, 1);
  assert.match(profile.sha256, /^[0-9a-f]{64}$/u);

  const wrongSpace = cmykProfile(); wrongSpace.write('RGB ', 16, 'ascii');
  assert.throws(() => inspectCmykOutputProfile(wrongSpace), { code: 'ICC_PROFILE_INVALID' });
  const badMagic = cmykProfile(); badMagic.write('xxxx', 36, 'ascii');
  assert.throws(() => inspectCmykOutputProfile(badMagic), { code: 'ICC_PROFILE_INVALID' });
  const badTag = cmykProfile(); badTag.writeUInt32BE(badTag.length + 1, 136);
  assert.throws(() => inspectCmykOutputProfile(badTag), { code: 'ICC_PROFILE_INVALID' });
  const wrongSize = cmykProfile(); wrongSize.writeUInt32BE(wrongSize.length - 1, 0);
  assert.throws(() => inspectCmykOutputProfile(wrongSize), { code: 'ICC_PROFILE_INVALID' });
});

test('installed Ghostscript profile is staged privately with an exact digest receipt', async (context) => {
  try { await access('/opt/homebrew/bin/gs'); } catch { context.skip('Fixed local Ghostscript is unavailable.'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'pdf-icc-profile-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const provider = new GhostscriptIccProfileProvider({
    registry: { probe: async () => ({ executable: '/opt/homebrew/bin/gs', version: '10.07.1' }) },
  });
  const staged = await provider.stageDefaultCmyk(workspace);
  assert.equal(staged.path, join(workspace, 'default-cmyk.icc'));
  assert.equal(staged.descriptor.colorSpace, 'CMYK');
  assert.equal(staged.descriptor.deviceClass, 'output');
  assert.equal(staged.engine.version, '10.07.1');
  assert.deepEqual(inspectCmykOutputProfile(await readFile(staged.path)), staged.descriptor);
  await assert.rejects(provider.stageDefaultCmyk(workspace), { code: 'ICC_PROFILE_UNAVAILABLE' });
});
