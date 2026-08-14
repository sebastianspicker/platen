import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { InputAssetStore, validateMagic } from '../scripts/host/input-asset-store.mjs';
import { isOdtPackage } from '../scripts/host/odt-package.mjs';
import { writeStoredZip } from '../scripts/host/pdf-ooxml-export-zip.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const odtContent = '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:text><text:p>Local ODT</text:p></office:text></office:body></office:document-content>';
const odtManifest = '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>';

function odtBytes(mediaType = 'application/vnd.oasis.opendocument.text', extra = []) {
  return writeStoredZip([
    ['mimetype', mediaType],
    ['content.xml', odtContent],
    ['META-INF/manifest.xml', odtManifest],
    ...extra,
  ]);
}

async function createStore(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-input-test-'));
  return { root, store: await new InputAssetStore({ root, ...options }).initialize() };
}

test('input store accepts signature-checked supported assets in private opaque paths', async () => {
  const { store } = await createStore();
  const image = await store.createInput({
    stream: Readable.from([png]), displayName: '../unsafe\\scan.png', mediaType: 'image/png',
  });
  assert.equal(image.displayName, 'scan.png');
  assert.equal(image.kind, 'image');
  assert.match(image.id, /^[0-9a-f-]{36}$/i);
  assert.equal(Object.hasOwn(image, 'directory'), false);
  assert.equal(Object.hasOwn(image, 'sourcePath'), false);
  assert.deepEqual(store.getInput(image.id), image);
  assert.equal(existsSync(store.getSourcePath(image.id)), true);
  assert.equal(await store.verifyInput(image.id), true);
  assert.equal(Object.isFrozen(image), true);

  const workspace = await store.createJobWorkspace(image.id);
  assert.equal(existsSync(workspace), true);
  await store.cleanupJob(workspace);
  await store.deleteInput(image.id);
  assert.throws(() => store.getInput(image.id), { code: 'INPUT_NOT_FOUND', status: 404 });
});

test('input store validates media types, extensions, signatures, and size before retaining bytes', async () => {
  const { store } = await createStore({ maxBytes: 16 });
  await assert.rejects(
    store.createInput({ stream: Readable.from([png]), displayName: 'scan.png', mediaType: 'text/plain' }),
    { code: 'INPUT_TYPE_MISMATCH', status: 415 },
  );
  await assert.rejects(
    store.createInput({ stream: Readable.from([Buffer.from('not png')]), displayName: 'scan.png', mediaType: 'image/png' }),
    { code: 'INVALID_INPUT_SIGNATURE', status: 415 },
  );
  await assert.rejects(
    store.createInput({ stream: Readable.from([Buffer.alloc(17)]), displayName: 'scan.png', mediaType: 'image/png' }),
    { code: 'FILE_TOO_LARGE', status: 413 },
  );
  await assert.rejects(
    store.createInput({ stream: Readable.from([Buffer.from('binary')]), displayName: 'program.exe', mediaType: 'application/octet-stream' }),
    { code: 'UNSUPPORTED_INPUT_FORMAT', status: 415 },
  );
});

test('input signature checks cover office, text, HTML, PostScript, and CAD families', () => {
  assert.equal(validateMagic('.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);
  assert.equal(validateMagic('.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), true);
  assert.equal(validateMagic('.txt', Buffer.from('local text')), true);
  assert.equal(validateMagic('.html', Buffer.from('<!doctype html><p>Local</p>')), true);
  assert.equal(validateMagic('.ps', Buffer.from('%!PS-Adobe-3.0')), true);
  assert.equal(validateMagic('.dxf', Buffer.from('0\nSECTION\n2\nHEADER')), true);
  assert.equal(validateMagic('.txt', Buffer.from([0, 1, 2])), false);
});

test('ODT admission requires the exact bounded ODF text package identity', async () => {
  const valid = odtBytes();
  assert.equal(isOdtPackage(valid), true);
  const { store } = await createStore();
  const asset = await store.createInput({
    stream: Readable.from([valid]),
    displayName: 'document.odt',
    mediaType: 'application/vnd.oasis.opendocument.text',
  });
  assert.equal(asset.extension, '.odt');
  for (const bytes of [
    Buffer.from('PK\x03\x04arbitrary-zip'),
    odtBytes('application/vnd.oasis.opendocument.spreadsheet'),
    odtBytes('application/vnd.oasis.opendocument.presentation'),
    odtBytes('application/vnd.openxmlformats-officedocument.wordprocessingml.document', [
      ['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<document/>'],
    ]),
  ]) {
    assert.equal(isOdtPackage(bytes), false);
    await assert.rejects(store.createInput({
      stream: Readable.from([bytes]),
      displayName: 'renamed.odt',
      mediaType: 'application/vnd.oasis.opendocument.text',
    }), { code: 'INVALID_INPUT_SIGNATURE', status: 415 });
  }
});
