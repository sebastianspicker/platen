import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from '../host-error.mjs';

export const SOURCE_RECORD_VERSION = 1;
export const OUTPUT_RECORD_VERSION = 1;
export const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const MAX_SOURCE_RECORDS = 256;
export const MAX_SOURCE_STORE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
export const MAX_OUTPUT_RECORDS = 256;
export const MAX_OUTPUT_STORE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_RECORD_BYTES = 1024;
export const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const TRANSACTION_VERSION = 1;
export const MAX_TRANSACTION_BYTES = 8 * 1024;

export function fail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Automation source staging was cancelled.');
}

export async function existingPrivateDirectory(path, missingCode, message) {
  let entry;
  try { entry = await lstat(path, { bigint: true }); } catch (error) {
    if (error?.code === 'ENOENT') fail(missingCode, message);
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory() || (entry.mode & 0o077n) !== 0n) {
    fail('AUTOMATION_ROOT_UNSAFE', 'Automation storage must be an existing private directory.');
  }
  return entry;
}

export async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY);
  try { await handle.sync(); } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally { await handle.close(); }
}

export function sameIdentity(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
    .every((key) => left[key] === right[key]);
}

export function checkedPrivateFile(metadata, expectedSize, maximumBytes) {
  return metadata.isFile() && !metadata.isSymbolicLink()
    && metadata.nlink === 1n && (metadata.mode & 0o077n) === 0n
    && metadata.size === BigInt(expectedSize)
    && metadata.size <= BigInt(maximumBytes);
}

export async function readPrivateFile(path, maximumBytes, {
  corruptCode = 'AUTOMATION_SOURCE_CORRUPT',
  corruptLabel = 'Automation source metadata',
} = {}) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || (before.mode & 0o077n) !== 0n || before.size < 1n
    || before.size > BigInt(maximumBytes)) {
    fail(corruptCode, `${corruptLabel} is unsafe.`, 500);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) {
      fail(corruptCode, `${corruptLabel} changed while opening.`, 500);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail(corruptCode, `${corruptLabel} is truncated.`, 500);
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, after)) {
      fail(corruptCode, `${corruptLabel} changed while reading.`, 500);
    }
    return bytes;
  } finally { await handle.close(); }
}

export function sourceRecord(value) {
  let record;
  try { record = JSON.parse(value.toString('utf8')); } catch (error) {
    fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source metadata is not valid JSON.', 500, error);
  }
  if (!record || Object.getPrototypeOf(record) !== Object.prototype
    || Object.keys(record).sort().join(',') !== 'id,sha256,size,version'
    || record.version !== SOURCE_RECORD_VERSION || !OPAQUE_ID.test(record.id)
    || !SHA256.test(record.sha256) || !Number.isSafeInteger(record.size)
    || record.size < 5 || record.size > MAX_SOURCE_BYTES) {
    fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source metadata is invalid.', 500);
  }
  return Object.freeze({ id: record.id, sha256: record.sha256, size: record.size });
}

export function outputRecord(value) {
  let record;
  try { record = JSON.parse(value.toString('utf8')); } catch (error) {
    fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output metadata is not valid JSON.', 500, error);
  }
  if (!record || Object.getPrototypeOf(record) !== Object.prototype
    || Object.keys(record).sort().join(',') !== 'id,sha256,size,sourceId,sourceSha256,version'
    || record.version !== OUTPUT_RECORD_VERSION || !OPAQUE_ID.test(record.id)
    || !OPAQUE_ID.test(record.sourceId) || !SHA256.test(record.sourceSha256)
    || !SHA256.test(record.sha256) || !Number.isSafeInteger(record.size)
    || record.size < 5 || record.size > MAX_OUTPUT_BYTES) {
    fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output metadata is invalid.', 500);
  }
  return Object.freeze({
    id: record.id, sha256: record.sha256, size: record.size,
    sourceId: record.sourceId, sourceSha256: record.sourceSha256,
  });
}

export function transactionReference(kind, record) {
  const sourceId = kind === 'source' ? record.id : record.sourceId;
  const sourceSha256 = kind === 'source' ? record.sha256 : record.sourceSha256;
  return Object.freeze({
    kind, id: record.id, sha256: record.sha256, size: record.size, sourceId, sourceSha256,
  });
}

export function sameTransactionReference(left, right) {
  return left && right && ['kind', 'id', 'sha256', 'size', 'sourceId', 'sourceSha256']
    .every((key) => left[key] === right[key]);
}

export function transactionMarker(value, kind) {
  let marker;
  try { marker = JSON.parse(value.toString('utf8')); } catch (error) {
    fail(`AUTOMATION_${kind.toUpperCase()}_CORRUPT`, 'Automation transaction marker is not valid JSON.', 500, error);
  }
  if (!marker || Object.getPrototypeOf(marker) !== Object.prototype
    || Object.keys(marker).sort().join(',') !== 'ref,state,version'
    || marker.version !== TRANSACTION_VERSION || !['staged', 'committed'].includes(marker.state)
    || !marker.ref || Object.getPrototypeOf(marker.ref) !== Object.prototype
    || Object.keys(marker.ref).sort().join(',') !== 'id,kind,sha256,size,sourceId,sourceSha256'
    || marker.ref.kind !== kind || !OPAQUE_ID.test(marker.ref.id)
    || !OPAQUE_ID.test(marker.ref.sourceId) || !SHA256.test(marker.ref.sha256)
    || !SHA256.test(marker.ref.sourceSha256) || !Number.isSafeInteger(marker.ref.size)
    || marker.ref.size < 5) {
    fail(`AUTOMATION_${kind.toUpperCase()}_CORRUPT`, 'Automation transaction marker is invalid.', 500);
  }
  return Object.freeze({
    version: marker.version, state: marker.state,
    ref: Object.freeze({ ...marker.ref }),
  });
}

export async function writePrivateJson(path, value, maximumBytes = MAX_TRANSACTION_BYTES) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maximumBytes) fail('AUTOMATION_TRANSACTION_CORRUPT', 'Automation transaction metadata is too large.', 500);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  await syncDirectory(join(path, '..'));
}

export async function readTransactionJournal(root, kind) {
  const path = join(root, 'transactions.json');
  let bytes;
  try {
    bytes = await readPrivateFile(path, MAX_TRANSACTION_BYTES, {
      corruptCode: `AUTOMATION_${kind.toUpperCase()}_CORRUPT`,
      corruptLabel: 'Automation transaction journal',
    });
  }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  let state;
  try { state = JSON.parse(bytes.toString('utf8')); } catch (error) { fail(`AUTOMATION_${kind.toUpperCase()}_CORRUPT`, 'Automation transaction journal is not valid JSON.', 500, error); }
  if (!state || Object.getPrototypeOf(state) !== Object.prototype
    || Object.keys(state).sort().join(',') !== 'transactions,version'
    || state.version !== TRANSACTION_VERSION || !Array.isArray(state.transactions)) {
    fail(`AUTOMATION_${kind.toUpperCase()}_CORRUPT`, 'Automation transaction journal is invalid.', 500);
  }
  for (const entry of state.transactions) {
    if (!entry || Object.getPrototypeOf(entry) !== Object.prototype
      || Object.keys(entry).sort().join(',') !== 'ref,state,version'
      || entry.version !== TRANSACTION_VERSION) {
      fail(`AUTOMATION_${kind.toUpperCase()}_CORRUPT`, 'Automation transaction journal entry is invalid.', 500);
    }
  }
  const entries = state.transactions.map((entry) => transactionMarker(Buffer.from(JSON.stringify(entry)), kind));
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.ref.id)) fail(`AUTOMATION_${kind.toUpperCase()}_CORRUPT`, 'Automation transaction journal contains duplicates.', 500);
    ids.add(entry.ref.id);
  }
  return entries;
}

export async function ensureTransactionJournal(root) {
  const path = join(root, 'transactions.json');
  try { await lstat(path); return; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await writePrivateJson(path, { version: TRANSACTION_VERSION, transactions: [] });
}

export async function digestHandle(handle, expectedSize) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, expectedSize));
  let offset = 0;
  while (offset < expectedSize) {
    const requested = Math.min(buffer.length, expectedSize - offset);
    const { bytesRead } = await handle.read(buffer, 0, requested, offset);
    if (bytesRead !== requested) {
      fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source content is truncated.', 500);
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) {
    fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source content exceeds its recorded size.', 500);
  }
  return hash.digest('hex');
}
