import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runJpegImageCommand } from '../scripts/cli/commands/jpeg-image.mjs';
import { PDF_JPEG_IMAGE_PROFILE } from '../scripts/host/pdf-jpeg-image-writer.mjs';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0, 0, 0xff, 0xd9, 0, 0]);
const jpegSha256 = createHash('sha256').update(jpeg).digest('hex');
test('JPEG CLI uploads and deletes exactly its transient input on success', async () => {
  const events = []; const input = { id: '123e4567-e89b-12d3-a456-426614174000', displayName: 'image.jpg', mediaType: 'image/jpeg', extension: '.jpg', size: jpeg.length, sha256: jpegSha256 };
  const application = { inputs: { createInput: async (value) => { events.push(['create', value.displayName, value.mediaType]); return input; }, verifyInput: async (id) => events.push(['verify', id]), deleteInput: async (id) => events.push(['delete', id]) }, jpegImageInsertion: { insert: async (_documentId, request) => { events.push(['insert', request.inputId, request.inputSha256, request.profile]); return { artifact: { id: 'artifact' }, kind: 'pdf-jpeg-image' }; } }, store: { getArtifact: () => ({ filePath: '/private/artifact.pdf' }) } };
  await runJpegImageCommand(application, { image: 'image.jpg', page: 1, rect: { x: 1, y: 2, width: 3, height: 4 }, output: '/tmp/output.pdf' }, { id: 'doc', sha256: 'b'.repeat(64) }, null, undefined, { cancelled() {}, readLocalInputBytes: async () => ({ bytes: Buffer.from(jpeg), displayName: 'image.jpg' }), copyExclusive: async (...args) => events.push(['copy', ...args]), emit: async () => {}, fail(code) { throw Object.assign(new Error(code), { code }); } });
  assert.deepEqual(events.map((entry) => entry[0]), ['create', 'verify', 'insert', 'copy', 'delete']); assert.equal(events[2][3], PDF_JPEG_IMAGE_PROFILE);
});

test('JPEG CLI deletes transient input when insertion fails', async () => {
  const events = []; const input = { id: '123e4567-e89b-12d3-a456-426614174000', displayName: 'image.jpg', mediaType: 'image/jpeg', extension: '.jpg', size: jpeg.length, sha256: jpegSha256 };
  const application = { inputs: { createInput: async () => input, verifyInput: async () => {}, deleteInput: async (id) => events.push(id) }, jpegImageInsertion: { insert: async () => { throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); } } };
  await assert.rejects(runJpegImageCommand(application, { image: 'image.jpg', page: 1, rect: { x: 1, y: 2, width: 3, height: 4 }, output: '/tmp/output.pdf' }, { id: 'doc', sha256: 'b'.repeat(64) }, null, undefined, { cancelled() {}, readLocalInputBytes: async () => ({ bytes: Buffer.from(jpeg), displayName: 'image.jpg' }), fail(code) { throw Object.assign(new Error(code), { code }); } }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(events, [input.id]);
});
