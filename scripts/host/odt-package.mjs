import { readZipEntries } from './zip-reader.mjs';

export const ODT_MEDIA_TYPE = 'application/vnd.oasis.opendocument.text';
const ODT_MEDIA_BYTES = Buffer.from(ODT_MEDIA_TYPE, 'ascii');
const ODT_LIMITS = Object.freeze({
  maximumEntries: 128,
  maximumEntryBytes: 16 * 1024 * 1024,
  maximumExpandedBytes: 64 * 1024 * 1024,
  maximumCompressionRatio: 100,
});

function hasExactFirstMimetypeEntry(bytes) {
  if (bytes.length < 38 + ODT_MEDIA_BYTES.length || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  const flags = bytes.readUInt16LE(6);
  const method = bytes.readUInt16LE(8);
  const compressedSize = bytes.readUInt32LE(18);
  const uncompressedSize = bytes.readUInt32LE(22);
  const nameLength = bytes.readUInt16LE(26);
  const extraLength = bytes.readUInt16LE(28);
  if (flags !== 0 || method !== 0 || nameLength !== 8 || extraLength !== 0
    || compressedSize !== ODT_MEDIA_BYTES.length || uncompressedSize !== ODT_MEDIA_BYTES.length
    || bytes.subarray(30, 38).toString('ascii') !== 'mimetype') return false;
  return bytes.subarray(38, 38 + ODT_MEDIA_BYTES.length).equals(ODT_MEDIA_BYTES);
}

function exactXmlDocument(bytes, root, namespace) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.includes(0)) return false;
  const text = bytes.toString('utf8').replace(/^\uFEFF/u, '').trimStart();
  return text.startsWith('<?xml')
    && new RegExp(`<${root}(?:\\s|>)`, 'u').test(text)
    && text.includes(namespace);
}

export function isOdtPackage(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source ?? []);
  if (bytes.length > 64 * 1024 * 1024 || !hasExactFirstMimetypeEntry(bytes)) return false;
  let entries;
  try { entries = readZipEntries(bytes, ODT_LIMITS); } catch { return false; }
  if (!entries.get('mimetype')?.equals(ODT_MEDIA_BYTES)
    || [...entries.keys()].some((name) => name === '[Content_Types].xml'
      || /^(?:word|xl|ppt)\//u.test(name))) return false;
  return exactXmlDocument(
    entries.get('content.xml'),
    'office:document-content',
    'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  ) && exactXmlDocument(
    entries.get('META-INF/manifest.xml'),
    'manifest:manifest',
    'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  );
}
