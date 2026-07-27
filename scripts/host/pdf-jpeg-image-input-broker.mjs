import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import { PDF_JPEG_IMAGE_PROFILE } from './pdf-jpeg-image-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_JPEG_BYTES = 16 * 1024 * 1024;
const MAX_PAGE = 10_000;

function host(code, message, status = 400, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function exactObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function normalizeRect(value) {
  if (!exactObject(value, ['x', 'y', 'width', 'height'])) throw host('INVALID_PDF_JPEG_IMAGE_OPTIONS', 'The JPEG image rectangle is invalid.');
  const rect = {};
  for (const [key, minimum] of [['x', -1_000_000], ['y', -1_000_000], ['width', 0], ['height', 0]]) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || Object.is(number, -0) || number < minimum || number > 1_000_000 || (!Number.isSafeInteger(number) && Number.isInteger(number))) throw host('INVALID_PDF_JPEG_IMAGE_OPTIONS', 'The JPEG image rectangle is invalid.');
    const rounded = Math.round(number * 1_000_000) / 1_000_000;
    if (rounded <= minimum && minimum >= 0) throw host('INVALID_PDF_JPEG_IMAGE_OPTIONS', 'The JPEG image rectangle is invalid.');
    rect[key] = rounded;
  }
  return Object.freeze(rect);
}

function validateRequest(value) {
  if (!exactObject(value, ['profile', 'sourceSha256', 'inputId', 'inputSha256', 'page', 'rect'])
    || value.profile !== PDF_JPEG_IMAGE_PROFILE
    || !SHA256.test(value.sourceSha256 ?? '')
    || !OPAQUE_ID.test(value.inputId ?? '')
    || !SHA256.test(value.inputSha256 ?? '')
    || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > MAX_PAGE) {
    throw host('INVALID_PDF_JPEG_IMAGE_OPTIONS', 'JPEG image insertion requires the fixed profile, source and input digests, page, and rectangle.', 400);
  }
  return Object.freeze({ ...value, rect: normalizeRect(value.rect) });
}

function statFingerprint(stat) {
  return Object.freeze({
    dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink), size: String(stat.size),
    mode: Number(stat.mode & (typeof stat.mode === 'bigint' ? 0o777n : 0o777)), mtimeNs: String(stat.mtimeNs ?? stat.mtimeMs), ctimeNs: String(stat.ctimeNs ?? stat.ctimeMs),
  });
}

function sameFingerprint(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function readStableJpeg(inputs, inputId, expectedSha256, { signal, expectedFingerprint = null } = {}) {
  if (signal?.aborted) throw host('JOB_CANCELLED', 'JPEG image processing was cancelled.', 499);
  let record;
  try { record = inputs.getInput(inputId); } catch (error) { throw error; }
  try { await inputs.verifyInput(inputId); } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENXIO'].includes(error?.code)) throw host('PDF_JPEG_IMAGE_INPUT_TAMPERED', 'The private JPEG input is unavailable or is not a regular private file.', 409, error);
    if (error instanceof HostError) throw host('PDF_JPEG_IMAGE_INPUT_TAMPERED', 'The private JPEG input failed its integrity check.', 409, error);
    throw host('PDF_JPEG_IMAGE_INPUT_READ_FAILED', 'The private JPEG input could not be verified safely.', 500, error);
  }
  if (record.mediaType !== 'image/jpeg' || !['.jpg', '.jpeg'].includes(record.extension)) throw host('PDF_JPEG_IMAGE_INPUT_UNSUPPORTED', 'The JPEG image input must be an image/jpeg .jpg or .jpeg asset.', 415);
  if (!Number.isSafeInteger(record.size) || record.size < 12 || record.size > MAX_JPEG_BYTES) throw host('PDF_JPEG_IMAGE_INPUT_TOO_LARGE', 'The JPEG image input exceeds the 16 MiB limit.', 413);
  if (!SHA256.test(expectedSha256 ?? '') || expectedSha256 !== record.sha256) throw host('PDF_JPEG_IMAGE_INPUT_MISMATCH', 'The JPEG image input digest does not match its private input record.', 409);

  const path = inputs.getSourcePath(inputId);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    const beforeFingerprint = statFingerprint(before);
    if (!before.isFile() || before.nlink !== 1n || beforeFingerprint.mode !== 0o600 || Number(before.size) !== record.size || (expectedFingerprint && !sameFingerprint(beforeFingerprint, expectedFingerprint))) throw host('PDF_JPEG_IMAGE_INPUT_TAMPERED', 'The private JPEG input changed before it could be processed.', 409);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      if (signal?.aborted) throw host('JOB_CANCELLED', 'JPEG image processing was cancelled.', 499);
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (bytesRead < 1) throw host('PDF_JPEG_IMAGE_INPUT_TAMPERED', 'The private JPEG input ended while it was being read.', 409);
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) throw host('PDF_JPEG_IMAGE_INPUT_TAMPERED', 'The private JPEG input grew while it was being read.', 409);
    const afterFingerprint = statFingerprint(await handle.stat({ bigint: true }));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!sameFingerprint(beforeFingerprint, afterFingerprint) || sha256 !== record.sha256 || sha256 !== expectedSha256) throw host('PDF_JPEG_IMAGE_INPUT_TAMPERED', 'The private JPEG input changed while it was being read.', 409);
    try { await inputs.verifyInput(inputId); } catch (error) { throw host('PDF_JPEG_IMAGE_INPUT_TAMPERED', 'The private JPEG input failed its post-read integrity check.', 409, error); }
    return Object.freeze({ bytes, sha256, size: bytes.length, fingerprint: beforeFingerprint });
  } catch (error) {
    if (error instanceof HostError) throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP' || error?.code === 'ENXIO') throw host('PDF_JPEG_IMAGE_INPUT_TAMPERED', 'The private JPEG input is unavailable or is not a regular private file.', 409, error);
    throw host('PDF_JPEG_IMAGE_INPUT_READ_FAILED', 'The private JPEG input could not be read safely.', 500, error);
  } finally { await handle?.close().catch(() => {}); }
}

export class PdfJpegImageInputBroker {
  #inputs; #service; #store;
  constructor({ inputs, service, store } = {}) {
    if (!inputs || typeof inputs.getInput !== 'function' || typeof inputs.getSourcePath !== 'function' || typeof inputs.verifyInput !== 'function' || typeof service?.insert !== 'function' || !store || typeof store.deleteArtifact !== 'function') throw new TypeError('PdfJpegImageInputBroker requires InputAssetStore, JPEG image service, and artifact store APIs.');
    this.#inputs = inputs; this.#service = service; this.#store = store;
  }

  async insert(documentId, value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = validateRequest(value);
    let input = null;
    let result = null;
    try {
      input = await readStableJpeg(this.#inputs, request.inputId, request.inputSha256, { signal });
      result = await this.#service.insert(documentId, { profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, rect: request.rect, jpegBytes: input.bytes }, { sourceSha256: request.sourceSha256, signal });
      if (signal?.aborted) throw host('JOB_CANCELLED', 'JPEG image processing was cancelled.', 499);
      let verification;
      try { verification = await readStableJpeg(this.#inputs, request.inputId, request.inputSha256, { signal, expectedFingerprint: input.fingerprint }); }
      finally { verification?.bytes.fill(0); }
      if (signal?.aborted) throw host('JOB_CANCELLED', 'JPEG image processing was cancelled.', 499);
      return result;
    } catch (error) {
      if (result?.artifact?.id) {
        try { await this.#store.deleteArtifact(result.artifact.id); }
        catch (cleanupError) { throw host('PDF_JPEG_IMAGE_CLEANUP_FAILED', 'JPEG image processing could not revoke its artifact.', 500, cleanupError); }
      }
      throw error;
    } finally { input?.bytes.fill(0); }
  }
}

export { readStableJpeg, validateRequest };
