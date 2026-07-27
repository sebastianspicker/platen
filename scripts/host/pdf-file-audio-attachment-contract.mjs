import { isProxy } from 'node:util/types';

export const PDF_FILE_AUDIO_ATTACHMENT_PROFILE = 'local-file-audio-attachment-v1';

const SHA256 = /^[0-9a-f]{64}$/u;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_COORDINATE = 1_000_000;

function invalid() {
  const error = new Error('PDF file/audio attachment request is invalid.');
  error.code = 'INVALID_PDF_FILE_AUDIO_ATTACHMENT';
  return error;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  return descriptors;
}

function number(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)
    || Math.abs(value) > MAX_COORDINATE) throw invalid();
  return Math.round(value * 1_000_000) / 1_000_000;
}

function rectValue(value) {
  const rect = exactObject(value, ['x', 'y', 'width', 'height']);
  const x = number(rect.x.value); const y = number(rect.y.value);
  const width = number(rect.width.value); const height = number(rect.height.value);
  if (width <= 0 || height <= 0 || x + width > MAX_COORDINATE || y + height > MAX_COORDINATE) throw invalid();
  return Object.freeze({ x, y, width, height });
}

export function normalizePdfFileAudioAttachment(value) {
  const request = exactObject(value, [
    'profile', 'sourceSha256', 'assetId', 'assetSha256', 'mediaType', 'extension', 'page', 'rect',
  ]);
  if (request.profile.value !== PDF_FILE_AUDIO_ATTACHMENT_PROFILE
    || !SHA256.test(request.sourceSha256.value ?? '')
    || !OPAQUE_ID.test(request.assetId.value ?? '')
    || !SHA256.test(request.assetSha256.value ?? '')
    || typeof request.mediaType.value !== 'string'
    || !['text/plain', 'application/octet-stream', 'audio/wav'].includes(request.mediaType.value)
    || typeof request.extension.value !== 'string'
    || !['.txt', '.bin', '.wav'].includes(request.extension.value)
    || !Number.isSafeInteger(request.page.value) || request.page.value < 1 || request.page.value > 100) throw invalid();
  if ((request.mediaType.value === 'audio/wav') !== (request.extension.value === '.wav')) throw invalid();
  if (request.mediaType.value === 'text/plain' && request.extension.value !== '.txt') throw invalid();
  if (request.mediaType.value === 'application/octet-stream' && request.extension.value !== '.bin') throw invalid();
  return Object.freeze({
    profile: PDF_FILE_AUDIO_ATTACHMENT_PROFILE,
    sourceSha256: request.sourceSha256.value,
    assetId: request.assetId.value,
    assetSha256: request.assetSha256.value,
    mediaType: request.mediaType.value,
    extension: request.extension.value,
    page: request.page.value,
    rect: rectValue(request.rect.value),
  });
}

export function pdfFileAudioAttachmentFailure() {
  return invalid();
}
