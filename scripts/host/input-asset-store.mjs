import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { cleanDisplayName } from './document-store.mjs';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';

export const DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024;

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERIC_MEDIA_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);
const DESCRIPTORS = new Map([
  ['.png', { kind: 'image', mediaTypes: ['image/png'] }],
  ['.jpg', { kind: 'image', mediaTypes: ['image/jpeg'] }],
  ['.jpeg', { kind: 'image', mediaTypes: ['image/jpeg'] }],
  ['.gif', { kind: 'image', mediaTypes: ['image/gif'] }],
  ['.bmp', { kind: 'image', mediaTypes: ['image/bmp', 'image/x-ms-bmp'] }],
  ['.tif', { kind: 'image', mediaTypes: ['image/tiff'] }],
  ['.tiff', { kind: 'image', mediaTypes: ['image/tiff'] }],
  ['.webp', { kind: 'image', mediaTypes: ['image/webp'] }],
  ['.doc', { kind: 'office', mediaTypes: ['application/msword'] }],
  ['.docx', { kind: 'office', mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] }],
  ['.odt', { kind: 'office', mediaTypes: ['application/vnd.oasis.opendocument.text'] }],
  ['.xls', { kind: 'office', mediaTypes: ['application/vnd.ms-excel'] }],
  ['.xlsx', { kind: 'office', mediaTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] }],
  ['.ods', { kind: 'office', mediaTypes: ['application/vnd.oasis.opendocument.spreadsheet'] }],
  ['.ppt', { kind: 'office', mediaTypes: ['application/vnd.ms-powerpoint'] }],
  ['.pptx', { kind: 'office', mediaTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] }],
  ['.odp', { kind: 'office', mediaTypes: ['application/vnd.oasis.opendocument.presentation'] }],
  ['.rtf', { kind: 'office', mediaTypes: ['application/rtf', 'text/rtf'] }],
  ['.txt', { kind: 'text', mediaTypes: ['text/plain'] }],
  ['.bin', { kind: 'binary', mediaTypes: ['application/octet-stream'] }],
  ['.wav', { kind: 'audio', mediaTypes: ['audio/wav'] }],
  ['.csv', { kind: 'office', mediaTypes: ['text/csv', 'application/csv'] }],
  ['.html', { kind: 'html', mediaTypes: ['text/html'] }],
  ['.htm', { kind: 'html', mediaTypes: ['text/html'] }],
  ['.ps', { kind: 'postscript', mediaTypes: ['application/postscript'] }],
  ['.eps', { kind: 'postscript', mediaTypes: ['application/postscript'] }],
  ['.dxf', { kind: 'cad', mediaTypes: ['image/vnd.dxf', 'application/dxf', 'application/x-dxf'] }],
]);

function hasPrefix(buffer, bytes) {
  return buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));
}

function textPrefix(buffer) {
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8').replace(/^\uFEFF/, '').trimStart();
}

function validateMagic(extension, prefix) {
  if (extension === '.png') return hasPrefix(prefix, [137, 80, 78, 71, 13, 10, 26, 10]);
  if (extension === '.jpg' || extension === '.jpeg') return hasPrefix(prefix, [0xff, 0xd8, 0xff]);
  if (extension === '.gif') return prefix.subarray(0, 6).toString('ascii') === 'GIF87a' || prefix.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (extension === '.bmp') return prefix.subarray(0, 2).toString('ascii') === 'BM';
  if (extension === '.tif' || extension === '.tiff') return hasPrefix(prefix, [0x49, 0x49, 0x2a, 0x00]) || hasPrefix(prefix, [0x4d, 0x4d, 0x00, 0x2a]);
  if (extension === '.webp') return prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP';
  if (['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'].includes(extension)) return hasPrefix(prefix, [0x50, 0x4b, 0x03, 0x04]);
  if (['.doc', '.xls', '.ppt'].includes(extension)) return hasPrefix(prefix, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (extension === '.bin') return prefix.length > 0;
  if (extension === '.wav') return prefix.length >= 12
    && prefix.subarray(0, 4).toString('ascii') === 'RIFF'
    && prefix.subarray(8, 12).toString('ascii') === 'WAVE';
  const text = textPrefix(prefix);
  if (text === null) return false;
  if (extension === '.rtf') return /^\{\\rtf/i.test(text);
  if (extension === '.html' || extension === '.htm') return /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<[a-z][^>]*>)/i.test(text);
  if (extension === '.ps' || extension === '.eps') return text.startsWith('%!PS');
  if (extension === '.dxf') return /^(?:0\s*(?:\r?\n)+\s*SECTION\b|999\b)/i.test(text);
  return extension === '.txt' || extension === '.csv';
}

function normalizeMediaType(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase() || 'application/octet-stream';
}

function descriptorFor(displayName, mediaType) {
  const extension = extname(displayName).toLowerCase();
  const descriptor = DESCRIPTORS.get(extension);
  if (!descriptor) throw new HostError('UNSUPPORTED_INPUT_FORMAT', 'This local conversion input format is not supported.', 415);
  const normalized = normalizeMediaType(mediaType);
  if (!GENERIC_MEDIA_TYPES.has(normalized) && !descriptor.mediaTypes.includes(normalized)) {
    throw new HostError('INPUT_TYPE_MISMATCH', 'The input media type does not match its supported file extension.', 415);
  }
  return { ...descriptor, extension, mediaType: normalized };
}

function freezeRecord(record) {
  return Object.freeze({ ...record });
}

function publicRecord(record) {
  return freezeRecord({
    id: record.id,
    displayName: record.displayName,
    mediaType: record.mediaType,
    kind: record.kind,
    extension: record.extension,
    size: record.size,
    sha256: record.sha256,
    createdAt: record.createdAt,
  });
}

export class InputAssetStore {
  #root;
  #maxBytes;
  #records = new Map();

  constructor({ root, maxBytes = DEFAULT_MAX_INPUT_BYTES }) {
    if (!root) throw new TypeError('InputAssetStore requires a private session root.');
    this.#root = resolve(root);
    this.#maxBytes = maxBytes;
  }

  async initialize() {
    await mkdir(join(this.#root, 'inputs'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.#root, 'input-jobs'), { recursive: true, mode: 0o700 });
    return this;
  }

  async createInput({ stream, displayName, mediaType }) {
    if (!stream?.[Symbol.asyncIterator]) throw new HostError('INVALID_BODY', 'An input request body is required.', 400);
    const safeName = cleanDisplayName(displayName, 'local-input.bin');
    const descriptor = descriptorFor(safeName, mediaType);
    const id = randomUUID();
    const directory = this.#inside('inputs', id);
    const partialPath = join(directory, 'source.partial');
    const sourcePath = join(directory, `source${descriptor.extension}`);
    await mkdir(directory, { mode: 0o700 });
    const hash = createHash('sha256');
    let handle;
    let size = 0;
    let prefix = Buffer.alloc(0);
    try {
      handle = await open(partialPath, 'wx', 0o600);
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > this.#maxBytes) {
          throw new HostError('FILE_TOO_LARGE', `The conversion input exceeds the ${this.#maxBytes}-byte limit.`, 413);
        }
        if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk]).subarray(0, 4096);
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (size === 0) throw new HostError('EMPTY_FILE', 'The conversion input is empty.', 400);
      if (!validateMagic(descriptor.extension, prefix)) {
        throw new HostError('INVALID_INPUT_SIGNATURE', 'The conversion input signature does not match its file extension.', 415);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(partialPath, sourcePath);
      await chmod(sourcePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const record = {
      id,
      displayName: safeName,
      mediaType: descriptor.mediaType,
      kind: descriptor.kind,
      extension: descriptor.extension,
      size,
      sha256: hash.digest('hex'),
      createdAt: new Date().toISOString(),
    };
    this.#records.set(id, { ...record, directory, sourcePath });
    return publicRecord(record);
  }

  getInput(id) {
    this.#assertId(id);
    const record = this.#records.get(id);
    if (!record) throw new HostError('INPUT_NOT_FOUND', 'The local conversion input was not found.', 404);
    return publicRecord(record);
  }

  getSourcePath(id) {
    this.getInput(id);
    return this.#records.get(id).sourcePath;
  }

  async verifyInput(id) {
    const record = this.#records.get(id);
    this.getInput(id);
    if (await digestFile(record.sourcePath) !== record.sha256) {
      throw new HostError('SOURCE_INTEGRITY_FAILED', 'The immutable conversion input no longer matches its digest.', 500);
    }
    return true;
  }

  async createJobWorkspace(id) {
    this.getInput(id);
    const directory = await mkdtemp(join(this.#root, 'input-jobs', `${id}-`));
    await chmod(directory, 0o700);
    return directory;
  }

  async cleanupJob(directory) {
    const target = resolve(directory);
    const jobsRoot = resolve(this.#root, 'input-jobs');
    if (!target.startsWith(`${jobsRoot}${sep}`)) {
      throw new HostError('INVALID_JOB_PATH', 'Refusing to clean a path outside the input job store.', 500);
    }
    await rm(target, { recursive: true, force: true });
  }

  async deleteInput(id) {
    const record = this.#records.get(id);
    this.getInput(id);
    this.#records.delete(id);
    await rm(record.directory, { recursive: true, force: true });
  }

  #inside(kind, id) {
    this.#assertId(id);
    const parent = resolve(this.#root, kind);
    const target = resolve(parent, id);
    if (!target.startsWith(`${parent}${sep}`)) throw new HostError('INVALID_ID', 'Invalid local resource identifier.', 400);
    return target;
  }

  #assertId(id) {
    if (!OPAQUE_ID.test(String(id ?? ''))) throw new HostError('INVALID_ID', 'Invalid local resource identifier.', 400);
  }
}

export { descriptorFor, normalizeMediaType, validateMagic };
