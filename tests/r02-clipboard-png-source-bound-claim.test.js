import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createDocumentGenerationController } from '../src/controllers/document-generation-controller.js';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { ImageMagickAdapter } from '../scripts/host/adapters/imagemagick.mjs';
import { GhostscriptAdapter } from '../scripts/host/adapters/ghostscript.mjs';
import { LibreOfficeAdapter } from '../scripts/host/adapters/libreoffice.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { ConversionService } from '../scripts/host/conversion-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { InputAssetStore } from '../scripts/host/input-asset-store.mjs';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';

class TestFile extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createClipboardFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r02-clipboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new DocumentStore({ root: join(root, 'documents') }).initialize();
  const inputs = await new InputAssetStore({ root: join(root, 'inputs') }).initialize();
  const registry = new EngineRegistry();
  const adapter = new PopplerAdapter({ registry });
  const conversion = new ConversionService({
    documents: store,
    inputs,
    poppler: adapter,
    ghostscript: new GhostscriptAdapter({ registry }),
    libreOffice: new LibreOfficeAdapter({ registry }),
    imageMagick: new ImageMagickAdapter({ registry }),
  });
  const png = encodeRgbaPng({
    width: 2,
    height: 2,
    pixels: Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
    ]),
  });
  const sourceDigest = digest(png);
  const events = [];
  const state = { busyAction: null, error: null, creationTitle: 'Clipboard PNG' };
  const errors = [];
  const opened = [];
  const operation = { controller: new AbortController() };
  const controller = createDocumentGenerationController({
    state,
    client: {
      async uploadInput(file) {
        const bytes = Buffer.from(await file.arrayBuffer());
        events.push(['upload', file.type, file.name, digest(bytes)]);
        return inputs.createInput({ stream: Readable.from([bytes]), displayName: file.name, mediaType: file.type });
      },
      async convertInput(id) {
        events.push(['convert', id]);
        return conversion.convertInput(id, { signal: operation.controller.signal });
      },
      async documentSource(id) {
        events.push(['source', id]);
        return new Blob([await readFile(store.getSourcePath(id))], { type: 'application/pdf' });
      },
      async deleteInput(id) {
        events.push(['delete-input', id]);
        return inputs.deleteInput(id);
      },
    },
    connectLocalHost: async () => events.push(['connect']),
    openFile: async (file) => {
      const bytes = Buffer.from(await file.arrayBuffer());
      opened.push({ file, bytes, sha256: digest(bytes) });
      events.push(['open', file.name]);
    },
    removeHostDocument: async (id) => {
      events.push(['delete-document', id]);
      return store.deleteDocument(id);
    },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => errors.push(error),
    finishOperation: () => { state.busyAction = null; },
    triggerDownload: () => {},
    render: () => {},
    announce: () => {},
    showError: (error) => errors.push(error),
    document: { querySelector: () => null },
    navigator: { clipboard: { read: async () => [{ types: ['image/png'], getType: async () => new Blob([png], { type: 'image/png' }) }] } },
    File: TestFile,
    crypto: webcrypto,
  });
  return { controller, conversion, inputs, store, png, sourceDigest, events, errors, opened, state };
}

test('R02 clipboard claim uses the real one-PNG upload, ImageMagick/Poppler conversion, digest check, and cleanup', async (t) => {
  const fixture = await createClipboardFixture(t);
  await fixture.controller.createClipboardToPdf();
  assert.equal(fixture.errors.length, 0);
  assert.equal(fixture.events[0][0], 'connect');
  assert.deepEqual(fixture.events[1].slice(0, 3), ['upload', 'image/png', 'clipboard-image.png']);
  assert.equal(fixture.events[1][3], fixture.sourceDigest);
  assert.equal(fixture.events.at(-1)[0], 'open');
  assert.equal(fixture.opened.length, 1);
  assert.equal(fixture.opened[0].file.type, 'application/pdf');
  assert.match(fixture.opened[0].file.name, /clipboard-image\.pdf$/u);
  assert.equal(fixture.opened[0].sha256, digest(fixture.opened[0].bytes));
  assert.equal(fixture.opened[0].bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(fixture.events.some(([kind]) => kind === 'delete-document'), true);
  assert.equal(fixture.events.some(([kind]) => kind === 'delete-input'), true);
});

test('R02 clipboard claim excludes text and arbitrary clipboard representations before upload', async (t) => {
  const fixture = await createClipboardFixture(t);
  fixture.controller = createDocumentGenerationController({
    state: fixture.state,
    client: { async uploadInput() { throw new Error('upload must not run'); } },
    connectLocalHost: async () => fixture.events.push(['connect']),
    openFile: async () => fixture.events.push(['open']),
    removeHostDocument: async () => {},
    captureOperation: () => ({ controller: new AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: (error) => fixture.errors.push(error),
    finishOperation: () => { fixture.state.busyAction = null; },
    triggerDownload: () => {}, render: () => {}, announce: () => {},
    showError: (error) => fixture.errors.push(error),
    document: { querySelector: () => null },
    navigator: { clipboard: { read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['not PNG']) }] } },
    File: TestFile, crypto: webcrypto,
  });
  await fixture.controller.createClipboardToPdf();
  assert.equal(fixture.events.some(([kind]) => kind === 'upload'), false);
  assert.match(fixture.errors.at(-1)?.message ?? '', /exactly one PNG representation/u);
});
