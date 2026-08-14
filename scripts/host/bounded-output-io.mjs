import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import {
  MAX_OCR_RASTER_BYTES,
  MAX_OCR_RASTER_PIXELS,
  PNG_SIGNATURE,
} from './pdf-service-limits.mjs';

function isSingleLinkRegularFile(metadata) {
  if (metadata.isSymbolicLink()) return false;
  if (!metadata.isFile()) return false;
  return metadata.nlink === 1;
}

function openedFileMatchesPath(metadata, pathMetadata) {
  if (!metadata.isFile()) return false;
  if (metadata.nlink !== 1) return false;
  if (metadata.dev !== pathMetadata.dev) return false;
  return metadata.ino === pathMetadata.ino;
}

function hasBoundedSize(size, minimumBytes, maximumBytes) {
  if (size < minimumBytes) return false;
  if (size > maximumBytes) return false;
  return true;
}

function hasCompletePngHeader(bytesRead, header) {
  if (bytesRead !== header.length) return false;
  if (!header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  return header.toString('ascii', 12, 16) === 'IHDR';
}

function hasBoundedPngDimensions(width, height) {
  if (!width || !height) return false;
  if (width > 16_384 || height > 16_384) return false;
  return width * height <= MAX_OCR_RASTER_PIXELS;
}

export async function openRegularOutput(filePath, {
  minimumBytes = 1,
  maximumBytes,
  label,
}) {
  let handle;
  try {
    const pathMetadata = await lstat(filePath);
    if (!isSingleLinkRegularFile(pathMetadata)) {
      throw new HostError(
        'INVALID_ENGINE_OUTPUT', `${label} is not a single-link regular file.`, 502,
      );
    }
    handle = await open(
      filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat();
    if (!openedFileMatchesPath(metadata, pathMetadata)
      || !hasBoundedSize(metadata.size, minimumBytes, maximumBytes)) {
      throw new HostError(
        'INVALID_ENGINE_OUTPUT',
        `${label} is not a bounded single-link regular file.`,
        502,
      );
    }
    return { handle, metadata };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof HostError) throw error;
    throw new HostError(
      'INVALID_ENGINE_OUTPUT', `${label} could not be opened safely.`, 502,
      { cause: error },
    );
  }
}

export async function readRegularOutput(filePath, options) {
  const { handle, metadata } = await openRegularOutput(filePath, options);
  try {
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes, offset, bytes.length - offset, offset,
      );
      if (!bytesRead) {
        throw new HostError(
          'INVALID_ENGINE_OUTPUT',
          `${options.label} changed while it was being read.`,
          502,
        );
      }
      offset += bytesRead;
    }
    const finalMetadata = await handle.stat();
    if (finalMetadata.size !== metadata.size
      || finalMetadata.mtimeMs !== metadata.mtimeMs
      || finalMetadata.ctimeMs !== metadata.ctimeMs) {
      throw new HostError(
        'INVALID_ENGINE_OUTPUT',
        `${options.label} changed while it was being read.`,
        502,
      );
    }
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

export function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new HostError(
      'INVALID_ENGINE_OUTPUT', `${label} is not valid UTF-8.`, 502,
      { cause: error },
    );
  }
}

export async function validatePngOutput(filePath, maximumBytes, label) {
  const { handle, metadata } = await openRegularOutput(filePath, {
    maximumBytes,
    label: `${label} PNG output`,
  });
  try {
    const prefix = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead !== PNG_SIGNATURE.length || !prefix.equals(PNG_SIGNATURE)) {
      throw new HostError(
        'INVALID_ENGINE_OUTPUT', `${label} output is not a PNG image.`, 502,
      );
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return metadata;
}

export async function pngDimensions(filePath) {
  const { handle } = await openRegularOutput(filePath, {
    maximumBytes: MAX_OCR_RASTER_BYTES,
    label: 'OCR raster PNG',
  });
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!hasCompletePngHeader(bytesRead, header)) {
      throw new HostError(
        'INVALID_ENGINE_OUTPUT', 'OCR raster PNG header is invalid.', 502,
      );
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (!hasBoundedPngDimensions(width, height)) {
      throw new HostError(
        'INVALID_ENGINE_OUTPUT', 'OCR raster PNG dimensions are invalid.', 502,
      );
    }
    return Object.freeze({ width, height });
  } finally {
    await handle.close().catch(() => {});
  }
}
