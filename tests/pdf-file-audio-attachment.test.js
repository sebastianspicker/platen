import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import {
  PDF_FILE_AUDIO_ATTACHMENT_PROFILE,
  normalizePdfFileAudioAttachment,
} from '../scripts/host/pdf-file-audio-attachment-contract.mjs';
import {
  inspectPdfFileAudioAttachment,
  validatePcmWav,
  writePdfFileAudioAttachment,
} from '../scripts/host/pdf-file-audio-attachment-writer.mjs';
import { PdfFileAudioAttachmentService } from '../scripts/host/pdf-file-audio-attachment-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const artifactId = '33333333-3333-4333-8333-333333333333';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const wav = () => {
  const data = Buffer.from([0, 0, 127, 127]); const out = Buffer.alloc(44 + data.length);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(8000, 24); out.writeUInt32LE(16000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36, 'ascii'); out.writeUInt32LE(data.length, 40); data.copy(out, 44); return out;
};
function request(source, asset, mediaType = 'text/plain', extension = '.txt') {
  return { profile: PDF_FILE_AUDIO_ATTACHMENT_PROFILE, sourceSha256: digest(source), assetId, assetSha256: digest(asset), mediaType, extension, page: 1, rect: { x: 2, y: 3, width: 20, height: 10 } };
}

test('PCM WAV parser is exact and rejects malformed or non-PCM input', () => {
  const bytes = wav(); assert.equal(validatePcmWav(bytes).sampleRate, 8000);
  const badSize = Buffer.from(bytes); badSize.writeUInt32LE(1, 4); assert.throws(() => validatePcmWav(badSize), { code: 'INVALID_PDF_FILE_AUDIO_ATTACHMENT' });
  const badFormat = Buffer.from(bytes); badFormat.writeUInt16LE(3, 20); assert.throws(() => validatePcmWav(badFormat), { code: 'INVALID_PDF_FILE_AUDIO_ATTACHMENT' });
  assert.throws(() => validatePcmWav(Buffer.from('RIFF')), { code: 'INVALID_PDF_FILE_AUDIO_ATTACHMENT' });
});

test('writer appends one inert FileAttachment and preserves source prefix', () => {
  const source = makeMultiPagePdf(['attachment']); const bytes = Buffer.from('hello'); const req = request(source, bytes);
  const written = writePdfFileAudioAttachment(source, req, { bytes, displayName: 'hello.txt', mediaType: 'text/plain', extension: '.txt', sha256: digest(bytes) });
  assert.equal(written.proof.sourcePrefixPreserved, true); assert.equal(written.proof.annotationCount, 1); assert.ok(written.bytes.subarray(0, source.length).equals(source));
  assert.deepEqual(inspectPdfFileAudioAttachment(source, written.bytes, req, written), written.proof);
  assert.throws(() => inspectPdfFileAudioAttachment(source, written.bytes, { ...req, assetId: '44444444-4444-4444-8444-444444444444' }, written), { code: 'INVALID_PDF_FILE_AUDIO_ATTACHMENT_OUTPUT' });
  assert.throws(() => writePdfFileAudioAttachment(source, req, { bytes, displayName: '../unsafe.txt', mediaType: 'text/plain', extension: '.txt', sha256: digest(bytes) }), { code: 'INVALID_PDF_FILE_AUDIO_ATTACHMENT' });
});

async function fixture(t, { abortAfterPromotion = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-file-audio-attachment-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = makeMultiPagePdf(['attachment']); const asset = Buffer.from('hello'); const sourcePath = join(root, 'source.pdf'); const assetPath = join(root, 'asset.txt'); await writeFile(sourcePath, source, { mode: 0o600 }); await writeFile(assetPath, asset, { mode: 0o600 }); await chmod(root, 0o700);
  const controller = new AbortController(); const observed = { sourceChecks: 0, inputChecks: 0, deleted: [] }; const req = request(source, asset);
  const store = { getDocument: () => ({ id: documentId, sha256: digest(source), size: source.length, displayName: 'source.pdf' }), getSourcePath: () => sourcePath, verifySource: async () => { observed.sourceChecks += 1; assert.equal(digest(await readFile(sourcePath)), digest(source)); }, createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); return path; }, cleanupJob: async (path) => rm(path, { recursive: true, force: true }), promotePdfArtifact: async (_id, _path, options) => { if (abortAfterPromotion) controller.abort(new Error('cancelled')); return { id: artifactId, sha256: options.expectedSha256, displayName: 'source-attachment.pdf', operation: options.operation }; }, deleteArtifact: async (id) => observed.deleted.push(id) };
  const inputs = { getInput: () => ({ id: assetId, displayName: 'hello.txt', mediaType: 'text/plain', extension: '.txt', size: asset.length, sha256: digest(asset) }), getSourcePath: () => assetPath, verifyInput: async () => { observed.inputChecks += 1; assert.equal(digest(await readFile(assetPath)), digest(asset)); } };
  return { service: new PdfFileAudioAttachmentService({ store, inputs }), req, source, asset, controller, observed };
}

test('service binds exact source and trusted input metadata and revokes post-promotion cancellation', async (t) => {
  const setup = await fixture(t);
  await assert.rejects(setup.service.add(documentId, { ...setup.req, sourceSha256: 'a'.repeat(64) }, { sourceSha256: digest(setup.source) }), { code: 'SOURCE_VERSION_MISMATCH' });
  await assert.rejects(setup.service.add(documentId, { ...setup.req, assetSha256: 'b'.repeat(64) }, { sourceSha256: digest(setup.source) }), { code: 'PDF_FILE_AUDIO_ATTACHMENT_INPUT_MISMATCH' });
  const cancelled = await fixture(t, { abortAfterPromotion: true });
  await assert.rejects(cancelled.service.add(documentId, cancelled.req, { sourceSha256: digest(cancelled.source), signal: cancelled.controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(cancelled.observed.deleted, [artifactId]);
});

test('audio attachment accepts only exact audio/wav .wav asset', () => {
  const source = makeMultiPagePdf(['audio']); const bytes = wav(); const req = request(source, bytes, 'audio/wav', '.wav');
  const written = writePdfFileAudioAttachment(source, req, { bytes, displayName: 'tone.wav', mediaType: 'audio/wav', extension: '.wav', sha256: digest(bytes) });
  assert.equal(written.proof.mediaType, 'audio/wav');
  assert.throws(() => normalizePdfFileAudioAttachment({ ...req, mediaType: 'audio/wav', extension: '.bin' }), { code: 'INVALID_PDF_FILE_AUDIO_ATTACHMENT' });
});

test('contract and writer reject proxy or accessor attachment records', () => {
  const source = makeMultiPagePdf(['hostile']); const bytes = Buffer.from('hello'); const req = request(source, bytes);
  assert.throws(() => normalizePdfFileAudioAttachment(new Proxy(req, {})), { code: 'INVALID_PDF_FILE_AUDIO_ATTACHMENT' });
  const accessor = { bytes, displayName: 'hello.txt', mediaType: 'text/plain', extension: '.txt', sha256: digest(bytes) };
  Object.defineProperty(accessor, 'displayName', { enumerable: true, get: () => 'hello.txt' });
  assert.throws(() => writePdfFileAudioAttachment(source, req, accessor), { code: 'INVALID_PDF_FILE_AUDIO_ATTACHMENT' });
  assert.throws(() => writePdfFileAudioAttachment(source, req, new Proxy({ bytes, displayName: 'hello.txt', mediaType: 'text/plain', extension: '.txt', sha256: digest(bytes) }, {})), { code: 'INVALID_PDF_FILE_AUDIO_ATTACHMENT' });
});
