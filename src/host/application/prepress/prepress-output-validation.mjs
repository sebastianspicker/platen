import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, publicImage } from './prepress-support.mjs';

export function createPrepressOutputValidator(limits) {
  async function assertRegular(path) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.nlink !== 1) fail('INVALID_ENGINE_OUTPUT', 'Prepress output must be a single-link regular file.', 502);
    return metadata;
  }
  async function assertInventory(workspace, allowed) {
    const entries = await readdir(workspace, { withFileTypes: true });
    if (entries.length !== allowed.size || entries.some((entry) => !allowed.has(entry.name) || !entry.isFile())) {
      fail('PREPRESS_WORKSPACE_INVALID', 'Prepress engine produced an unexpected workspace entry.', 502);
    }
    for (const name of allowed) await assertRegular(join(workspace, name));
  }
  async function readBoundedFile(path, maximumBytes) {
    let handle;
    try {
      const initial = await lstat(path);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size < 1 || initial.size > maximumBytes) fail('INVALID_ENGINE_OUTPUT', 'Prepress validation output is not a bounded regular file.', 502);
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.dev !== initial.dev || metadata.ino !== initial.ino || metadata.size !== initial.size) fail('INVALID_ENGINE_OUTPUT', 'Prepress validation output changed before reading.', 502);
      const bytes = Buffer.alloc(metadata.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) fail('INVALID_ENGINE_OUTPUT', 'Prepress validation output was truncated.', 502);
      return bytes;
    } finally { await handle?.close().catch(() => {}); }
  }
  async function readPreview(path, label) { return publicImage(await readBoundedFile(path, limits.maxPreviewBytes), label, limits); }
  async function validateTiff(path) {
    let handle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 16 || metadata.size > limits.maxSeparationSourceBytes) fail('INVALID_ENGINE_OUTPUT', 'Separation TIFF is not a bounded regular file.', 502);
      const bytes = Buffer.alloc(Math.min(metadata.size, 1024 * 1024));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const header = bytes.subarray(0, bytesRead);
      const little = header.subarray(0, 2).toString('ascii') === 'II'; const big = header.subarray(0, 2).toString('ascii') === 'MM';
      if (!little && !big) fail('INVALID_ENGINE_OUTPUT', 'Separation output is not a TIFF.', 502);
      const u16 = (at) => little ? header.readUInt16LE(at) : header.readUInt16BE(at);
      const u32 = (at) => little ? header.readUInt32LE(at) : header.readUInt32BE(at);
      if (u16(2) !== 42) fail('INVALID_ENGINE_OUTPUT', 'Separation TIFF header is invalid.', 502);
      const ifd = u32(4);
      if (ifd + 2 > header.length) fail('INVALID_ENGINE_OUTPUT', 'Separation TIFF IFD is outside the bounded header.', 502);
      const count = u16(ifd); let width = 0; let height = 0;
      for (let index = 0; index < count; index += 1) {
        const at = ifd + 2 + index * 12;
        if (at + 12 > header.length) fail('INVALID_ENGINE_OUTPUT', 'Separation TIFF IFD is truncated.', 502);
        const tag = u16(at); const type = u16(at + 2); const values = u32(at + 4);
        if (![256, 257].includes(tag)) continue;
        if (values !== 1 || ![3, 4].includes(type)) fail('INVALID_ENGINE_OUTPUT', 'Separation TIFF dimensions use an unsupported encoding.', 502);
        const value = type === 3 ? u16(at + 8) : u32(at + 8);
        if (tag === 256) width = value; else height = value;
      }
      if (!width || !height || width > limits.maxRasterDimension || height > limits.maxRasterDimension || width * height > limits.maxRasterPixels) fail('PREPRESS_OUTPUT_LIMIT', 'Separation TIFF dimensions exceed local limits.', 413);
    } finally { await handle?.close().catch(() => {}); }
  }
  return Object.freeze({ assertRegular, assertInventory, listWorkspace: (workspace) => readdir(workspace), readBoundedFile, readPreview, validateTiff });
}
