import { crc32 } from './zip-reader.mjs';

export const OOXML_ZIP_LIMITS = Object.freeze({
  maximumEntries: 128,
  maximumEntryBytes: 16 * 1024 * 1024,
  maximumArchiveBytes: 64 * 1024 * 1024,
});

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_OOXML_ARCHIVE';
  throw error;
}

function safeEntryName(value) {
  const name = String(value ?? '');
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')
    || /^[a-z]:/iu.test(name) || name.split('/').some((part) => part === '..')) {
    invalid('OOXML entry names must be relative safe paths.');
  }
  return name;
}

function entryBytes(value, name) {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value ?? ''), 'utf8');
  if (bytes.length > OOXML_ZIP_LIMITS.maximumEntryBytes) {
    invalid(`OOXML entry ${name} exceeds the bounded entry size.`);
  }
  return bytes;
}

function localHeader(name, bytes, offset) {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30 + nameBytes.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc32(bytes), 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  nameBytes.copy(header, 30);
  return { header, offset };
}

function centralHeader(name, bytes, localOffset) {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(46 + nameBytes.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(crc32(bytes), 16);
  header.writeUInt32LE(bytes.length, 20);
  header.writeUInt32LE(bytes.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  nameBytes.copy(header, 46);
  return header;
}

/**
 * Write a deterministic, stored-only ZIP suitable for the narrow OOXML
 * packages emitted by this project. Entries are sorted and use zero DOS time.
 */
export function writeStoredZip(entries, limits = OOXML_ZIP_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > limits.maximumEntries) {
    invalid('OOXML ZIP entries must be a non-empty bounded array.');
  }
  const normalized = entries.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) invalid(`OOXML ZIP entry ${index} is malformed.`);
    const name = safeEntryName(entry[0]);
    return { name, bytes: entryBytes(entry[1], name) };
  }).sort((left, right) => left.name.localeCompare(right.name));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].name === normalized[index].name) invalid('OOXML ZIP entries must have unique names.');
  }
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of normalized) {
    const local = localHeader(entry.name, entry.bytes, offset);
    locals.push(local.header, entry.bytes);
    central.push(centralHeader(entry.name, entry.bytes, offset));
    offset += local.header.length + entry.bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  const output = Buffer.concat([...locals, centralBytes, end]);
  if (output.length > limits.maximumArchiveBytes) invalid('OOXML ZIP exceeds the bounded archive size.');
  return output;
}
