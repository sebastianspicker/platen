import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';

export const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const MAX_JOB_MS = 2 * 60_000;
export const SHA256 = /^[0-9a-f]{64}$/;
export const BEFORE_FILES = Object.freeze(['input.pdf']);
export const AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

export function createJobSignal(externalSignal) {
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  if (externalSignal?.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('PDFKit protection deadline exceeded.'));
  }, MAX_JOB_MS);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  });
}

export async function assertWorkspace(workspace, expected) {
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

export async function fileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  return Object.freeze({
    dev: metadata.dev, ino: metadata.ino, size: metadata.size,
    mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs,
  });
}

export async function assertIdentity(path, expected) {
  const actual = await fileIdentity(path);
  if (Object.keys(expected).some((key) => actual[key] !== expected[key])) {
    fail('PDFKIT_WORKSPACE_INVALID', 'A PDFKit workspace file changed during validation.', 502);
  }
}

export async function readStableOutput(path) {
  const pathMetadata = await lstat(path);
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.nlink !== 1
    || (pathMetadata.mode & 0o077) !== 0 || pathMetadata.size < 64 || pathMetadata.size > MAX_OUTPUT_BYTES) {
    fail('PDFKIT_OUTPUT_INVALID', 'The PDFKit helper did not produce a bounded private PDF.', 502);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n
      || before.dev !== BigInt(pathMetadata.dev) || before.ino !== BigInt(pathMetadata.ino)) {
      fail('PDFKIT_OUTPUT_INVALID', 'The PDFKit protection output changed before validation.', 502);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (bytes.length !== Number(before.size)
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key])) {
      fail('PDFKIT_OUTPUT_INVALID', 'The PDFKit protection output changed during validation.', 502);
    }
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function assertPng(path) {
  let handle = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 24n || before.size > 32n * 1024n * 1024n) {
      fail('PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', 'A protection-removal validation render was unsafe.', 502);
    }
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    const after = await handle.stat({ bigint: true });
    if (bytesRead !== signature.length || !signature.equals(PNG_SIGNATURE)
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key])) {
      fail('PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', 'A protection-removal validation render was invalid.', 502);
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function freezeResult(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeResult(child);
  return Object.freeze(value);
}

export async function promoteValidatedPdfArtifact({
  store, documentId, outputPath, displayName, operation, outputDigest, signal, invalidCode, invalidMessage,
}) {
  const artifact = await store.promotePdfArtifact(documentId, outputPath, {
    displayName, operation, expectedSha256: outputDigest, signal,
  });
  if (artifact.sha256 !== outputDigest) fail(invalidCode, invalidMessage, 502);
  return artifact;
}
