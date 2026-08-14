import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';

export const MAX_PDFKIT_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_PDFKIT_OUTPUT_BYTES = 256 * 1024 * 1024;
export const PDFKIT_PAGE_BOX_EPSILON = 0.01;
export const PDFKIT_WORKSPACE_BEFORE_FILES = Object.freeze(['input.pdf', 'request.json']);
export const PDFKIT_WORKSPACE_AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf', 'request.json']);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export async function writePrivatePdfKitRequest(path, contents) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(path, 0o400);
}

export async function assertPdfKitWorkspace(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    fail('PDFKIT_WORKSPACE_INVALID', 'The PDFKit helper changed its private workspace topology.', 502);
  }
  for (const entry of entries) {
    const metadata = await lstat(join(workspace, entry));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      fail('PDFKIT_WORKSPACE_INVALID', 'The PDFKit helper workspace contains an unsafe file.', 502);
    }
  }
}

export async function assertPdfKitOutput(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0 || metadata.size < 5 || metadata.size > MAX_PDFKIT_OUTPUT_BYTES) {
    fail('PDFKIT_OUTPUT_INVALID', 'The PDFKit helper did not produce a bounded private PDF.', 502);
  }
  return metadata;
}

export async function pdfKitFileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  return Object.freeze({
    dev: metadata.dev, ino: metadata.ino, size: metadata.size,
    mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs,
  });
}

export async function assertPdfKitFileIdentity(path, expected) {
  const actual = await pdfKitFileIdentity(path);
  if (Object.keys(expected).some((key) => actual[key] !== expected[key])) {
    fail('PDFKIT_WORKSPACE_INVALID', 'A PDFKit workspace file changed during validation.', 502);
  }
}

export async function assertPdfKitPng(path) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < PNG_SIGNATURE.length || metadata.size > 16 * 1024 * 1024) {
      fail('PDFKIT_OUTPUT_INVALID', 'Poppler did not produce a bounded validation image.', 502);
    }
    await handle.chmod(0o400);
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead !== signature.length || !signature.equals(PNG_SIGNATURE)) {
      fail('PDFKIT_OUTPUT_INVALID', 'Poppler validation output is not a PNG image.', 502);
    }
  } finally { await handle.close(); }
}

export function parsePdfKitInspectedPageRotation(output, page) {
  const match = String(output ?? '').match(new RegExp(`(?:Page\\s+${page}\\s+)?rot:\\s*(-?\\d+)`, 'i'));
  const value = Number.parseInt(match?.[1] ?? '', 10);
  if (!Number.isSafeInteger(value) || value % 90 !== 0) {
    fail('PDFKIT_POSTFLIGHT_INVALID', `Poppler did not report a valid rotation for page ${page}.`, 502);
  }
  return ((value % 360) + 360) % 360;
}

export function pdfKitPopplerBoxRectangle(box, label) {
  if (!box || typeof box !== 'object') fail('PDFKIT_POSTFLIGHT_INVALID', `Poppler did not report ${label}.`, 502);
  return Object.freeze({ x: box.left, y: box.bottom, width: box.width, height: box.height });
}

export function pdfKitRectanglesMatch(actual, expected, epsilon = PDFKIT_PAGE_BOX_EPSILON) {
  return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(actual?.[key])
    && Number.isFinite(expected?.[key]) && Math.abs(actual[key] - expected[key]) <= epsilon);
}

export function pdfKitRectangleWithin(inner, outer) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export function freezePdfKitMutationResult(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezePdfKitMutationResult(child);
  return Object.freeze(value);
}
