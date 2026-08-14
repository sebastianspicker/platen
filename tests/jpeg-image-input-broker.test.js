import assert from 'node:assert/strict';
import { symlink, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { InputAssetStore } from '../scripts/host/input-asset-store.mjs';
import { PdfJpegImageInputBroker } from '../scripts/host/pdf-jpeg-image-input-broker.mjs';
import { PDF_JPEG_IMAGE_PROFILE } from '../scripts/host/pdf-jpeg-image-writer.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0, 0, 0xff, 0xd9, 0, 0]);
const DOCUMENT = '123e4567-e89b-12d3-a456-426614174000';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'jpeg-broker-')); const inputs = await new InputAssetStore({ root }).initialize();
  const asset = await inputs.createInput({ stream: Readable.from([JPEG]), displayName: 'image.jpg', mediaType: 'image/jpeg' });
  const deleted = []; const calls = []; const service = { insert: async (_id, request) => { calls.push(request); return { artifact: { id: 'artifact' } }; } };
  const broker = new PdfJpegImageInputBroker({ inputs, service, store: { deleteArtifact: async (id) => deleted.push(id) } });
  const request = { profile: PDF_JPEG_IMAGE_PROFILE, sourceSha256: 'a'.repeat(64), inputId: asset.id, inputSha256: asset.sha256, page: 1, rect: { x: 1, y: 2, width: 3, height: 4 } };
  return { root, inputs, asset, broker, request, calls, deleted };
}

test('JPEG input broker resolves private bytes, re-verifies, and zeroes buffers', async (context) => { const value = await setup(); context.after(() => rm(value.root, { recursive: true, force: true })); await value.broker.insert(DOCUMENT, value.request); assert.equal(value.calls.length, 1); assert(value.calls[0].jpegBytes.every((byte) => byte === 0)); assert.equal(value.deleted.length, 0); });
test('JPEG input broker rejects wrong digest and symlinked or replaced inputs', async (context) => { const value = await setup(); context.after(() => rm(value.root, { recursive: true, force: true })); await assert.rejects(value.broker.insert(DOCUMENT, { ...value.request, inputSha256: 'b'.repeat(64) }), { code: 'PDF_JPEG_IMAGE_INPUT_MISMATCH' }); const path = value.inputs.getSourcePath(value.asset.id); await rm(path); await symlink('/tmp/no-such-jpeg', path); await assert.rejects(value.broker.insert(DOCUMENT, value.request), { code: 'PDF_JPEG_IMAGE_INPUT_TAMPERED' }); });
test('JPEG input broker revokes output after cancellation', async (context) => { const value = await setup(); context.after(() => rm(value.root, { recursive: true, force: true })); const controller = new AbortController(); value.broker = new PdfJpegImageInputBroker({ inputs: value.inputs, service: { insert: async () => { controller.abort(); return { artifact: { id: 'artifact' } }; } }, store: { deleteArtifact: async (id) => value.deleted.push(id) } }); await assert.rejects(value.broker.insert(DOCUMENT, value.request, { signal: controller.signal }), { code: 'JOB_CANCELLED' }); assert.deepEqual(value.deleted, ['artifact']); });
