import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { createOcrUserDictionary } from '../scripts/host/ocr-job-helpers.mjs';

test('OCR user dictionary is a private, exclusive UTF-8 workspace file with canonical digest', async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdf-ocr-words-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const dictionary = await createOcrUserDictionary(workspace, ['caf\u00e9', 'and/or']);
  const bytes = Buffer.from('caf\u00e9\nand/or\n', 'utf8');
  assert.equal(dictionary.path, join(workspace, 'ocr-user-words.txt'));
  assert.equal(dictionary.termCount, 2);
  assert.equal(dictionary.digest, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(dictionary.path), bytes);
  assert.equal((await stat(dictionary.path)).mode & 0o777, 0o600);
  await assert.rejects(() => createOcrUserDictionary(workspace, ['other']), { code: 'OCR_USER_DICTIONARY_EXISTS' });
});

for (const entry of [
  { value: ['  caf\u00e9  '], label: 'noncanonical whitespace' },
  { value: ['cafe\u0301'], label: 'noncanonical NFC' },
  { value: ['line\nbreak'], label: 'newline' },
  { value: ['term\u0000'], label: 'control' },
  { value: ['same', 'same'], label: 'duplicate' },
  { value: ['/private/words'], label: 'path-like' },
  { value: ['\ud800'], label: 'unpaired surrogate' },
]) {
  test(`OCR user dictionary rejects ${entry.label} terms`, async (context) => {
    const workspace = await mkdtemp(join(tmpdir(), 'pdf-ocr-words-'));
    context.after(() => rm(workspace, { recursive: true, force: true }));
    let error;
    try {
      await createOcrUserDictionary(workspace, entry.value);
      assert.fail('Expected createOcrUserDictionary to reject invalid terms.');
    } catch (thrown) {
      error = thrown;
    }
    assert.equal(error.code, 'OCR_CONTRACT_INVALID');
    assert.equal(error.message.includes('cafe'), false);
    assert.equal(error.message.includes('/'), false);
  });
}

test('OCR user dictionary rejects workspace that is not a directory', async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdf-ocr-words-'));
  const workspaceFile = join(workspace, 'not-a-directory');
  await writeFile(workspaceFile, 'i am a file', 'utf8');
  context.after(() => rm(workspace, { recursive: true, force: true }));
  let error;
  try {
    await createOcrUserDictionary(workspaceFile, ['safe']);
    assert.fail('Expected createOcrUserDictionary to reject a non-directory workspace.');
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error.code, 'OCR_USER_DICTIONARY_WORKSPACE_UNAVAILABLE');
  assert.equal(error.message.includes('/'), false);
});

test('OCR user dictionary rejects symlinked workspace', async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdf-ocr-words-'));
  const workspaceLink = join(workspace, 'workspace-link');
  await symlink(workspace, workspaceLink, 'dir');
  context.after(() => rm(workspace, { recursive: true, force: true }));
  let error;
  try {
    await createOcrUserDictionary(workspaceLink, ['safe']);
    assert.fail('Expected createOcrUserDictionary to reject symlinked workspace input.');
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error.code, 'OCR_USER_DICTIONARY_WORKSPACE_INVALID');
});

test('OCR user dictionary rejects preexisting target path', async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'pdf-ocr-words-'));
  const path = join(workspace, 'ocr-user-words.txt');
  await writeFile(path, 'preexisting', 'utf8');
  context.after(() => rm(workspace, { recursive: true, force: true }));
  let error;
  try {
    await createOcrUserDictionary(workspace, ['safe']);
    assert.fail('Expected createOcrUserDictionary to reject an existing target.');
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error.code, 'OCR_USER_DICTIONARY_EXISTS');
  assert.equal(error.message.includes('exists'), true);
});
