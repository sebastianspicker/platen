import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { HostError } from './host-error.mjs';

const MAX_TOKEN_OVERHEAD_BYTES = 4 * 1024;
const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

function boundaryError(cause = undefined) {
  return new HostError(
    'SIGNATURE_DUMP_INVALID',
    'The signature contents are not a bounded direct PDF string.',
    502,
    cause === undefined ? undefined : { cause },
  );
}

function isHexDigit(value) {
  return (value >= 0x30 && value <= 0x39)
    || (value >= 0x41 && value <= 0x46)
    || (value >= 0x61 && value <= 0x66);
}

function trimPdfWhitespace(bytes) {
  let start = 0;
  let end = bytes.length;
  while (start < end && PDF_WHITESPACE.has(bytes[start])) start += 1;
  while (end > start && PDF_WHITESPACE.has(bytes[end - 1])) end -= 1;
  return { start, end };
}

function hexStringLength(bytes, start, end) {
  if (bytes[start] !== 0x3c || bytes[end - 1] !== 0x3e || bytes[start + 1] === 0x3c) {
    throw boundaryError();
  }
  let digits = 0;
  for (let index = start + 1; index < end - 1; index += 1) {
    if (PDF_WHITESPACE.has(bytes[index])) continue;
    if (!isHexDigit(bytes[index])) throw boundaryError();
    digits += 1;
  }
  return Math.ceil(digits / 2);
}

function literalStringLength(bytes, start, end) {
  if (bytes[start] !== 0x28) throw boundaryError();
  let depth = 1;
  let decodedBytes = 0;
  let index = start + 1;
  while (index < end) {
    const value = bytes[index];
    if (value === 0x5c) {
      index += 1;
      if (index >= end) throw boundaryError();
      const escaped = bytes[index];
      if (escaped === 0x0a) { index += 1; continue; }
      if (escaped === 0x0d) {
        index += bytes[index + 1] === 0x0a ? 2 : 1;
        continue;
      }
      if (escaped >= 0x30 && escaped <= 0x37) {
        let octalDigits = 1;
        while (octalDigits < 3 && index + 1 < end
          && bytes[index + 1] >= 0x30 && bytes[index + 1] <= 0x37) {
          index += 1;
          octalDigits += 1;
        }
      }
      decodedBytes += 1;
      index += 1;
      continue;
    }
    if (value === 0x28) {
      depth += 1;
      decodedBytes += 1;
      index += 1;
      continue;
    }
    if (value === 0x29) {
      depth -= 1;
      if (depth === 0) {
        index += 1;
        while (index < end && PDF_WHITESPACE.has(bytes[index])) index += 1;
        if (index !== end) throw boundaryError();
        return decodedBytes;
      }
      if (depth < 0) throw boundaryError();
      decodedBytes += 1;
      index += 1;
      continue;
    }
    decodedBytes += 1;
    index += 1;
  }
  throw boundaryError();
}

export function decodedPdfStringLength(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2) throw boundaryError();
  const { start, end } = trimPdfWhitespace(bytes);
  if (end - start < 2) throw boundaryError();
  if (bytes[start] === 0x3c) return hexStringLength(bytes, start, end);
  return literalStringLength(bytes, start, end);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function checkedLimits(maxBytesPerSignature, maxBytesTotal) {
  if (!Number.isSafeInteger(maxBytesPerSignature) || maxBytesPerSignature < 2
    || !Number.isSafeInteger(maxBytesTotal) || maxBytesTotal < maxBytesPerSignature) {
    throw new TypeError('signature content limits must be positive bounded integers');
  }
  return { maxBytesPerSignature, maxBytesTotal };
}

export async function inspectSignatureContentBounds({
  input,
  signatures,
  maxBytesPerSignature,
  maxBytesTotal,
} = {}) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) {
    throw new TypeError('input must be an absolute path without NUL bytes');
  }
  if (!Array.isArray(signatures) || signatures.length < 1) {
    throw new TypeError('signatures must be a non-empty array');
  }
  const limits = checkedLimits(maxBytesPerSignature, maxBytesTotal);
  let handle;
  try {
    handle = await open(input, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n
      || (before.mode & 0o077n) !== 0n || (uid !== null && before.uid !== uid)) throw boundaryError();
    const fileSize = Number(before.size);
    if (!Number.isSafeInteger(fileSize)) throw boundaryError();

    const spans = signatures.map((signature) => {
      const range = signature?.byteRange;
      if (!Array.isArray(range) || range.length !== 4
        || !range.every((value) => Number.isSafeInteger(value) && value >= 0)) throw boundaryError();
      const [firstOffset, firstLength, secondOffset, secondLength] = range;
      if (firstOffset !== 0 || firstLength < 1 || secondOffset <= firstLength || secondLength < 1
        || secondOffset > fileSize || secondLength > fileSize - secondOffset) throw boundaryError();
      const encodedBytes = secondOffset - firstLength;
      if (encodedBytes > limits.maxBytesPerSignature * 4 + MAX_TOKEN_OVERHEAD_BYTES) throw boundaryError();
      return { start: firstLength, end: secondOffset, encodedBytes };
    });
    const ordered = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
    if (ordered.some((span, index) => index > 0 && span.start < ordered[index - 1].end)) throw boundaryError();

    let totalBytes = 0;
    const decodedSizes = [];
    for (const span of spans) {
      const bytes = Buffer.allocUnsafe(span.encodedBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, span.start + offset);
        if (bytesRead < 1) throw boundaryError();
        offset += bytesRead;
      }
      const decodedBytes = decodedPdfStringLength(bytes);
      if (decodedBytes < 2 || decodedBytes > limits.maxBytesPerSignature
        || decodedBytes > limits.maxBytesTotal - totalBytes) throw boundaryError();
      totalBytes += decodedBytes;
      decodedSizes.push(decodedBytes);
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw boundaryError();
    return Object.freeze(decodedSizes);
  } catch (error) {
    if (error instanceof HostError || error instanceof TypeError) throw error;
    throw boundaryError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}
