import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import {
  MAX_OCR_RASTER_BYTES,
  MAX_OCR_RASTER_PIXELS,
  PNG_SIGNATURE,
} from './pdf-service-limits.mjs';

export async function openRegularOutput(filePath, {
  minimumBytes = 1,
  maximumBytes,
  label,
}) {
  let handle;
  try {
    const pathMetadata = await lstat(filePath);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
      || pathMetadata.nlink !== 1) {
      throw new HostError(
        'INVALID_ENGINE_OUTPUT', `${label} is not a single-link regular file.`, 502,
      );
    }
    handle = await open(
      filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1
      || metadata.dev !== pathMetadata.dev || metadata.ino !== pathMetadata.ino
      || metadata.size < minimumBytes || metadata.size > maximumBytes) {
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
    if (bytesRead !== header.length
      || !header.subarray(0, 8).equals(PNG_SIGNATURE)
      || header.toString('ascii', 12, 16) !== 'IHDR') {
      throw new HostError(
        'INVALID_ENGINE_OUTPUT', 'OCR raster PNG header is invalid.', 502,
      );
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (!width || !height || width > 16_384 || height > 16_384
      || width * height > MAX_OCR_RASTER_PIXELS) {
      throw new HostError(
        'INVALID_ENGINE_OUTPUT', 'OCR raster PNG dimensions are invalid.', 502,
      );
    }
    return Object.freeze({ width, height });
  } finally {
    await handle.close().catch(() => {});
  }
}
