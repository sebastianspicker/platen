import { inflateRawSync } from 'node:zlib';
import { HostError } from './host-error.mjs';

export const ZIP_LIMITS = Object.freeze({
  maximumEntries: 256,
  maximumEntryBytes: 16 * 1024 * 1024,
  maximumExpandedBytes: 64 * 1024 * 1024,
  maximumCompressionRatio: 100,
});

function archiveError(code, message, status = 422) {
  return new HostError(code, message, status);
}

function safeName(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name)
    || name.split('/').some((part) => part === '..')) {
    throw archiveError('INVALID_ARCHIVE_PATH', 'The archive contains an unsafe entry path.');
  }
  return name;
}

function findEndOfCentralDirectory(bytes) {
  const first = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw archiveError('INVALID_ARCHIVE', 'The archive does not contain a ZIP central directory.');
}

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Read a bounded, non-encrypted ZIP archive using its central directory. */
export function readZipEntries(source, limits = ZIP_LIMITS) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (bytes.length < 22) throw archiveError('INVALID_ARCHIVE', 'The archive is too small to be a ZIP file.');
  const end = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(end + 4);
  const centralDisk = bytes.readUInt16LE(end + 6);
  const entries = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (disk !== 0 || centralDisk !== 0 || bytes.readUInt16LE(end + 8) !== entries) {
    throw archiveError('UNSUPPORTED_ARCHIVE_FEATURE', 'Multi-disk ZIP archives are not supported.');
  }
  if (entries > limits.maximumEntries || centralOffset + centralSize > end || centralOffset > bytes.length) {
    throw archiveError('ARCHIVE_LIMIT_EXCEEDED', 'The archive exceeds local entry limits.', 413);
  }
  const results = new Map();
  let offset = centralOffset;
  let expanded = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > centralOffset + centralSize || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw archiveError('INVALID_ARCHIVE', 'The ZIP central directory is malformed.');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize || flags & 1) {
      throw archiveError(flags & 1 ? 'UNSUPPORTED_ARCHIVE_FEATURE' : 'INVALID_ARCHIVE', flags & 1 ? 'Encrypted ZIP entries are not supported.' : 'The ZIP entry is malformed.');
    }
    if (method !== 0 && method !== 8) throw archiveError('UNSUPPORTED_ARCHIVE_FEATURE', 'Only stored and deflated ZIP entries are supported.');
    if (uncompressedSize > limits.maximumEntryBytes || expanded + uncompressedSize > limits.maximumExpandedBytes
      || (compressedSize === 0 ? uncompressedSize > 0 : uncompressedSize / compressedSize > limits.maximumCompressionRatio)) {
      throw archiveError('ARCHIVE_LIMIT_EXCEEDED', 'The archive exceeds local expansion limits.', 413);
    }
    const name = safeName(bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    if (results.has(name)) throw archiveError('INVALID_ARCHIVE', 'The archive contains duplicate entry names.');
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw archiveError('INVALID_ARCHIVE', 'The ZIP local entry is malformed.');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw archiveError('INVALID_ARCHIVE', 'The ZIP entry data is truncated.');
    let data;
    try { data = method === 0 ? Buffer.from(bytes.subarray(dataStart, dataEnd)) : inflateRawSync(bytes.subarray(dataStart, dataEnd)); } catch {
      throw archiveError('INVALID_ARCHIVE', 'The ZIP entry could not be decompressed.');
    }
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) throw archiveError('INVALID_ARCHIVE', 'The ZIP entry integrity check failed.');
    results.set(name, data);
    expanded += data.length;
    offset = next;
  }
  return results;
}
