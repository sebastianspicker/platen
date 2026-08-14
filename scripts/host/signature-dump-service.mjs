import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { HostError } from './host-error.mjs';
import { acceptedPdfsigStderr } from './pdf-evidence-parsers.mjs';
import { inspectSignatureContentBounds } from './signature-contents-boundary.mjs';
import {
  captureBoundedSignatureFifos,
  promoteCapturedSignatureFiles,
} from './signature-fifo-capture.mjs';

export const MAX_SIGNATURE_DUMP_BYTES = 1024 * 1024;
export const MAX_SIGNATURE_DUMP_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_SIGNATURE_DUMP_COUNT = 100;

const DIGEST = /^[0-9a-f]{64}$/;
const DUMP_NAME = /^input\.pdf\.sig(?:0|[1-9]\d{0,2})$/;

function dumpError(cause = undefined) {
  return new HostError(
    'SIGNATURE_DUMP_INVALID',
    'The isolated signature backend did not produce a complete bounded CMS inventory.',
    502,
    cause === undefined ? undefined : { cause },
  );
}

function checkedPaths({ input, nssDirectory, dumpDirectory }) {
  for (const [name, value] of Object.entries({ input, nssDirectory, dumpDirectory })) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
      throw new TypeError(`${name} must be an absolute path without NUL bytes`);
    }
  }
  if (basename(input) !== 'input.pdf') throw new TypeError('input must use the fixed input.pdf filename');
  return { input, nssDirectory, dumpDirectory };
}

async function assertPrivateDirectory(path) {
  const metadata = await lstat(path, { bigint: true });
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077n) !== 0n
    || (uid !== null && metadata.uid !== uid)) throw dumpError();
}

function parseDumpReceipt(stdout, signatureCount) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > 64 * 1024
    || !Number.isSafeInteger(signatureCount) || signatureCount < 1
    || signatureCount > MAX_SIGNATURE_DUMP_COUNT) throw dumpError();
  const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
  if (lines.length !== signatureCount + 1 || lines[0] !== `Dumping Signatures: ${signatureCount}`) {
    throw dumpError();
  }
  const records = [];
  for (let index = 0; index < signatureCount; index += 1) {
    const match = lines[index + 1].match(/^Signature #(\d+) \((\d+) bytes\) => (input\.pdf\.sig\d+)$/);
    const size = Number(match?.[2]);
    const filename = match?.[3];
    if (!match || Number(match[1]) !== index || !DUMP_NAME.test(filename)
      || filename !== `input.pdf.sig${index}` || !Number.isSafeInteger(size)
      || size < 2 || size > MAX_SIGNATURE_DUMP_BYTES) throw dumpError();
    records.push(Object.freeze({ index, filename, size }));
  }
  return Object.freeze(records);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameFileAcrossChmod(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

async function digestDump(path, expectedSize) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== BigInt(expectedSize)
      || opened.size < 2n || opened.size > BigInt(MAX_SIGNATURE_DUMP_BYTES)
      || (uid !== null && opened.uid !== uid)) throw dumpError();
    await handle.chmod(0o400);
    const before = await handle.stat({ bigint: true });
    if (!sameFileAcrossChmod(opened, before) || (before.mode & 0o777n) !== 0o400n) throw dumpError();
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const { bytesRead } = await handle.read(bytes, offset, expectedSize - offset, offset);
      if (bytesRead < 1) throw dumpError();
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) throw dumpError();
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw dumpError();
    return createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw dumpError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function dumpEmbeddedSignatures(adapter, options = {}) {
  if (!adapter || typeof adapter.execute !== 'function') {
    throw new TypeError('adapter must expose execute(operation, parameters, options)');
  }
  const { input, nssDirectory, dumpDirectory } = checkedPaths(options);
  const { signatures } = options;
  if (!Array.isArray(signatures) || signatures.length < 1
    || signatures.length > MAX_SIGNATURE_DUMP_COUNT) throw new TypeError('signatures must be a bounded non-empty array');
  const expectedNames = signatures.map((_signature, index) => `input.pdf.sig${index}`);
  await Promise.all([assertPrivateDirectory(nssDirectory), assertPrivateDirectory(dumpDirectory)]);
  if ((await readdir(dumpDirectory)).length !== 0) throw dumpError();
  const contentBounds = await inspectSignatureContentBounds({
    input,
    signatures,
    maxBytesPerSignature: MAX_SIGNATURE_DUMP_BYTES,
    maxBytesTotal: MAX_SIGNATURE_DUMP_TOTAL_BYTES,
  });
  let result;
  let buffers;
  try {
    ({ result, buffers } = await captureBoundedSignatureFifos({
      dumpDirectory,
      names: expectedNames,
      signal: options.signal,
      maxBytesPerFile: MAX_SIGNATURE_DUMP_BYTES,
      maxBytesTotal: MAX_SIGNATURE_DUMP_TOTAL_BYTES,
      execute: (signal) => adapter.execute('dumpSignatures', { input, nssDirectory }, {
        cwd: dumpDirectory,
        signal,
        timeoutMs: options.timeoutMs ?? 30_000,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      }),
    }));
  } catch (error) {
    if (error?.code === 'ENGINE_CANCELLED') throw error;
    throw dumpError(error);
  }
  if ((result.exitCode ?? 0) !== 0 || !acceptedPdfsigStderr(result.stderr ?? '')) throw dumpError();
  const receipt = parseDumpReceipt(result.stdout, signatures.length);

  let totalBytes = 0;
  for (const [index, item] of receipt.entries()) {
    totalBytes += item.size;
    if (buffers[index].length !== item.size || item.size > contentBounds[index]
      || totalBytes > MAX_SIGNATURE_DUMP_TOTAL_BYTES) throw dumpError();
  }
  await promoteCapturedSignatureFiles({ dumpDirectory, names: expectedNames, buffers });

  totalBytes = 0;
  const records = [];
  for (const [index, item] of receipt.entries()) {
    totalBytes += item.size;
    if (item.size > contentBounds[index] || totalBytes > MAX_SIGNATURE_DUMP_TOTAL_BYTES) throw dumpError();
    const signature = signatures[index];
    if (!signature || !Array.isArray(signature.byteRange) || signature.byteRange.length !== 4
      || !(signature.signatureType === null || typeof signature.signatureType === 'string')) throw dumpError();
    const cmsSha256 = await digestDump(join(dumpDirectory, item.filename), item.size);
    if (!DIGEST.test(cmsSha256)) throw dumpError();
    records.push(Object.freeze({
      byteRange: Object.freeze([...signature.byteRange]),
      subFilter: signature.signatureType,
      cmsFilename: `dumps/${item.filename}`,
      cmsSha256,
    }));
  }
  return Object.freeze(records);
}
