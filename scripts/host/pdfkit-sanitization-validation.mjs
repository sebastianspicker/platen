import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import {
  parseAttachments, parseCustomMetadata, parseDocumentUrls, parsePdfInfo, parseXmpMetadata,
} from './pdf-service-foundation.mjs';

export const MAX_PDFKIT_SANITIZATION_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_PDFKIT_SANITIZATION_OUTPUT_BYTES = 256 * 1024 * 1024;
export const PDFKIT_SANITIZATION_BEFORE_FILES = Object.freeze(['input.pdf']);
export const PDFKIT_SANITIZATION_AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
export const PDFKIT_SANITIZATION_CATEGORY_ORDER = Object.freeze(['document-info', 'custom-info', 'xmp']);
export const PDFKIT_SANITIZATION_INFO_FIELDS = Object.freeze([
  'title', 'author', 'subject', 'keywords', 'creator', 'producer', 'createdAt', 'modifiedAt',
]);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export async function assertPdfKitSanitizationWorkspace(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    fail('PDFKIT_SANITIZATION_WORKSPACE_INVALID', 'The PDFKit helper changed its private workspace topology.', 502);
  }
  for (const entry of entries) {
    const metadata = await lstat(join(workspace, entry));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      fail('PDFKIT_SANITIZATION_WORKSPACE_INVALID', 'The PDFKit sanitization workspace contains an unsafe file.', 502);
    }
  }
}

export async function pdfKitSanitizationFileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs });
}

export async function assertPdfKitSanitizationIdentity(path, expected) {
  const actual = await pdfKitSanitizationFileIdentity(path);
  if (Object.keys(expected).some((key) => actual[key] !== expected[key])) {
    fail('PDFKIT_SANITIZATION_WORKSPACE_INVALID', 'A PDFKit sanitization workspace file changed during validation.', 502);
  }
}

export async function readStablePdfKitSanitizationOutput(path) {
  const pathMetadata = await lstat(path);
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.nlink !== 1
    || (pathMetadata.mode & 0o077) !== 0 || pathMetadata.size < 64 || pathMetadata.size > MAX_PDFKIT_SANITIZATION_OUTPUT_BYTES) {
    fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'The PDFKit helper did not produce a bounded private PDF.', 502);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.dev !== BigInt(pathMetadata.dev) || before.ino !== BigInt(pathMetadata.ino)) {
      fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'The metadata-sanitized output changed before validation.', 502);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (bytes.length !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key])) {
      fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'The metadata-sanitized output changed during validation.', 502);
    }
    return bytes;
  } finally { await handle.close().catch(() => {}); }
}

export async function assertPdfKitSanitizationPng(path) {
  let handle = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 24n || before.size > 32n * 1024n * 1024n) {
      fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'A metadata-sanitization validation render was unsafe.', 502);
    }
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    const after = await handle.stat({ bigint: true });
    if (bytesRead !== signature.length || !signature.equals(PNG_SIGNATURE) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key])) {
      fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'A metadata-sanitization validation render was invalid.', 502);
    }
  } finally { await handle?.close().catch(() => {}); }
}

export function observedPdfKitMetadataCategories(inspection, xmp, custom) {
  const categories = [];
  if (PDFKIT_SANITIZATION_INFO_FIELDS.some((field) => inspection[field] !== null)) categories.push('document-info');
  if (custom.length > 0) categories.push('custom-info');
  if (xmp.present) categories.push('xmp');
  return Object.freeze(categories);
}

export function pdfKitMetadataCategoriesMatch(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((category, index) => category === expected[index])
    && actual.every((category) => PDFKIT_SANITIZATION_CATEGORY_ORDER.includes(category));
}

export function pdfKitMetadataAbsent(inspection, xmp, custom) {
  return PDFKIT_SANITIZATION_INFO_FIELDS.every((field) => inspection[field] === null)
    && inspection.raw.customMetadata?.toLowerCase() === 'no' && inspection.raw.metadataStream?.toLowerCase() === 'no'
    && xmp.present === false && custom.length === 0;
}

export function pdfKitSanitizationRunOptions(workspace, signal, maxStdoutBytes = 4 * 1024 * 1024) {
  return { cwd: workspace, signal, timeoutMs: 30_000, maxStdoutBytes, maxStderrBytes: 256 * 1024 };
}

export async function inspectPdfKitSanitizationEnvelope(poppler, input, workspace, signal) {
  const options = pdfKitSanitizationRunOptions(workspace, signal);
  const [infoResult, xmpResult, customResult, attachmentsResult, urlsResult] = await Promise.all([
    poppler.execute('inspect', { input }, options), poppler.execute('inspectMetadata', { input }, options),
    poppler.execute('inspectCustomMetadata', { input }, options), poppler.execute('listAttachments', { input }, options),
    poppler.execute('inspectUrls', { input }, options),
  ]);
  return Object.freeze({ inspection: parsePdfInfo(infoResult.stdout), xmp: parseXmpMetadata(xmpResult.stdout), custom: parseCustomMetadata(customResult.stdout), attachments: parseAttachments(attachmentsResult.stdout), urls: parseDocumentUrls(urlsResult.stdout) });
}
