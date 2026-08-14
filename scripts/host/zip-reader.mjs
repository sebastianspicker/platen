import { inflateRawSync } from 'node:zlib';
import { HostError } from './host-error.mjs';

export const ZIP_LIMITS = Object.freeze({
  maximumEntries: 256,
  maximumEntryBytes: 16 * 1024 * 1024,
  maximumExpandedBytes: 64 * 1024 * 1024,
  maximumCompressionRatio: 100,
});

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => Array.from({ length: 8 })
  .reduce((current) => (current >>> 1) ^ (current & 1 ? 0xedb88320 : 0), value));

function archiveError(code, message, status = 422) {
  return new HostError(code, message, status);
}

function safeName(name) {
  if (hasUnsafePathComponent(name)) {
    throw archiveError('INVALID_ARCHIVE_PATH', 'The archive contains an unsafe entry path.');
  }
  return name;
}

function hasUnsafePathComponent(name) {
  return !name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name)
    || name.split('/').some((part) => part === '..');
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
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function readCentralDirectoryHeader(bytes, end) {
  return Object.fromEntries([
    ['disk', bytes.readUInt16LE(end + 4)],
    ['centralDisk', bytes.readUInt16LE(end + 6)],
    ['entriesOnDisk', bytes.readUInt16LE(end + 8)],
    ['entries', bytes.readUInt16LE(end + 10)],
    ['centralSize', bytes.readUInt32LE(end + 12)],
    ['centralOffset', bytes.readUInt32LE(end + 16)],
  ]);
}

function validateCentralDirectory(header, end, bytes, limits) {
  if (header.disk !== 0 || header.centralDisk !== 0 || header.entriesOnDisk !== header.entries) {
    throw archiveError('UNSUPPORTED_ARCHIVE_FEATURE', 'Multi-disk ZIP archives are not supported.');
  }
  if (header.entries > limits.maximumEntries || header.centralOffset + header.centralSize > end
    || header.centralOffset > bytes.length) {
    throw archiveError('ARCHIVE_LIMIT_EXCEEDED', 'The archive exceeds local entry limits.', 413);
  }
}

function readCentralRecord(bytes, offset, centralEnd) {
  if (offset + 46 > centralEnd || bytes.readUInt32LE(offset) !== 0x02014b50) {
    throw archiveError('INVALID_ARCHIVE', 'The ZIP central directory is malformed.');
  }
  const record = {
    flags: bytes.readUInt16LE(offset + 8),
    method: bytes.readUInt16LE(offset + 10),
    expectedCrc: bytes.readUInt32LE(offset + 16),
    compressedSize: bytes.readUInt32LE(offset + 20),
    uncompressedSize: bytes.readUInt32LE(offset + 24),
    nameLength: bytes.readUInt16LE(offset + 28),
    extraLength: bytes.readUInt16LE(offset + 30),
    commentLength: bytes.readUInt16LE(offset + 32),
    localOffset: bytes.readUInt32LE(offset + 42),
  };
  record.next = offset + 46 + record.nameLength + record.extraLength + record.commentLength;
  if (record.next > centralEnd || record.flags & 1) {
    throw archiveError(record.flags & 1 ? 'UNSUPPORTED_ARCHIVE_FEATURE' : 'INVALID_ARCHIVE', record.flags & 1 ? 'Encrypted ZIP entries are not supported.' : 'The ZIP entry is malformed.');
  }
  return record;
}

function validateEntryPolicy(record, expanded, limits) {
  if (record.method !== 0 && record.method !== 8) {
    throw archiveError('UNSUPPORTED_ARCHIVE_FEATURE', 'Only stored and deflated ZIP entries are supported.');
  }
  if (record.uncompressedSize > limits.maximumEntryBytes || expanded + record.uncompressedSize > limits.maximumExpandedBytes
    || (record.compressedSize === 0 ? record.uncompressedSize > 0 : record.uncompressedSize / record.compressedSize > limits.maximumCompressionRatio)) {
    throw archiveError('ARCHIVE_LIMIT_EXCEEDED', 'The archive exceeds local expansion limits.', 413);
  }
}

function entryName(bytes, record, offset) {
  return safeName(bytes.subarray(offset + 46, offset + 46 + record.nameLength).toString('utf8'));
}

function readCompressedData(bytes, record) {
  if (record.localOffset + 30 > bytes.length || bytes.readUInt32LE(record.localOffset) !== 0x04034b50) {
    throw archiveError('INVALID_ARCHIVE', 'The ZIP local entry is malformed.');
  }
  const localNameLength = bytes.readUInt16LE(record.localOffset + 26);
  const localExtraLength = bytes.readUInt16LE(record.localOffset + 28);
  const dataStart = record.localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataEnd > bytes.length) throw archiveError('INVALID_ARCHIVE', 'The ZIP entry data is truncated.');
  return bytes.subarray(dataStart, dataEnd);
}

function decompressEntry(compressedData, record) {
  try {
    return record.method === 0 ? Buffer.from(compressedData) : inflateRawSync(compressedData);
  } catch {
    throw archiveError('INVALID_ARCHIVE', 'The ZIP entry could not be decompressed.');
  }
}

function validateEntryIntegrity(data, record) {
  if (data.length !== record.uncompressedSize || crc32(data) !== record.expectedCrc) {
    throw archiveError('INVALID_ARCHIVE', 'The ZIP entry integrity check failed.');
  }
}

/** Read a bounded, non-encrypted ZIP archive using its central directory. */
export function readZipEntries(source, limits = ZIP_LIMITS) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (bytes.length < 22) throw archiveError('INVALID_ARCHIVE', 'The archive is too small to be a ZIP file.');
  const end = findEndOfCentralDirectory(bytes);
  const header = readCentralDirectoryHeader(bytes, end);
  validateCentralDirectory(header, end, bytes, limits);
  const results = new Map();
  const centralEnd = header.centralOffset + header.centralSize;
  let offset = header.centralOffset;
  let expanded = 0;
  for (let index = 0; index < header.entries; index += 1) {
    const record = readCentralRecord(bytes, offset, centralEnd);
    validateEntryPolicy(record, expanded, limits);
    const name = entryName(bytes, record, offset);
    if (results.has(name)) throw archiveError('INVALID_ARCHIVE', 'The archive contains duplicate entry names.');
    const data = decompressEntry(readCompressedData(bytes, record), record);
    validateEntryIntegrity(data, record);
    results.set(name, data);
    expanded += data.length;
    offset = record.next;
  }
  return results;
}
