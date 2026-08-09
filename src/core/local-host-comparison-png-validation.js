const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function uint32(bytes, offset) { return (bytes[offset] * 2 ** 24) + (bytes[offset + 1] * 2 ** 16) + (bytes[offset + 2] * 256) + bytes[offset + 3]; }
async function inflate(bytes, maximum) {
  if (typeof DecompressionStream !== 'function' || typeof Blob !== 'function') return null;
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; if (size > maximum) return null;
      chunks.push(value);
    }
    const output = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  } catch { return null; }
}
export async function validateComparisonPng(bytes, maximumBytes, maximumPixels) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 57 || bytes.length > maximumBytes
    || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  let offset = 8; let width = 0; let height = 0; let sawHeader = false; let sawData = false; const idat = [];
  while (offset < bytes.length) {
    if (offset > bytes.length - 12) return null;
    const length = uint32(bytes, offset); const dataStart = offset + 8; const dataEnd = dataStart + length; const next = dataEnd + 4;
    if (length > maximumBytes || next > bytes.length || crc32(bytes.slice(offset + 4, dataEnd)) !== uint32(bytes, dataEnd)) return null;
    const type = String.fromCharCode(...bytes.slice(offset + 4, dataStart));
    if (!/^[A-Za-z]{4}$/u.test(type) || (bytes[offset + 6] & 32) !== 0) return null;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return null;
      width = uint32(bytes, dataStart); height = uint32(bytes, dataStart + 4);
      if (!width || !height || width > 8192 || height > 8192 || width > Math.floor(maximumPixels / height)
        || bytes[dataStart + 8] !== 8 || bytes[dataStart + 9] !== 6 || bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0) return null;
      sawHeader = true;
    } else if (type === 'IDAT') { sawData = true; idat.push(bytes.slice(dataStart, dataEnd)); }
    else if (type === 'IEND') {
      if (!sawData || length !== 0 || next !== bytes.length) return null;
      const raw = await inflate(concat(idat), ((width * 4) + 1) * height);
      if (!raw || raw.length !== ((width * 4) + 1) * height) return null;
      for (let row = 0; row < height; row += 1) if (raw[row * ((width * 4) + 1)] > 4) return null;
      return Object.freeze({ width, height });
    } else if ((bytes[offset + 4] & 32) === 0 || sawData) return null;
    offset = next;
  }
  return null;
}
function concat(chunks) { const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0); const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
