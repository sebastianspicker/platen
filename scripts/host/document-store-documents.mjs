import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { validateOperationProvenance } from './operation-provenance.mjs';
import { assertActive, assertOpaqueId, cleanDisplayName, containsPdfHeader, freezeRecord, insideStore } from './document-store-contract.mjs';
import { digestFile } from './document-store-file-io.mjs';

export async function createDocument(state, { stream, displayName, mediaType = 'application/pdf', operation = null }) {
  assertActive(state);
  if (!stream?.[Symbol.asyncIterator]) throw new HostError('INVALID_BODY', 'A PDF request body is required.', 400);
  const provenance = operation === null ? null : validateOperationProvenance(operation);
  const id = randomUUID();
  const directory = insideStore(state, 'documents', id);
  const partialPath = join(directory, 'source.partial');
  const sourcePath = join(directory, 'source.pdf');
  await mkdir(directory, { mode: 0o700 });
  const hash = createHash('sha256');
  let handle;
  let size = 0;
  let prefix = Buffer.alloc(0);
  try {
    handle = await open(partialPath, 'wx', 0o600);
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > state.maxBytes) throw new HostError('FILE_TOO_LARGE', `The selected PDF exceeds the ${state.maxBytes}-byte local host limit.`, 413);
      if (prefix.length < 1024) prefix = Buffer.concat([prefix, chunk]).subarray(0, 1024);
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (size === 0) throw new HostError('EMPTY_FILE', 'The selected PDF is empty.', 400);
    if (!containsPdfHeader(prefix)) throw new HostError('INVALID_PDF_HEADER', 'The selected file does not contain a PDF header in its first 1,024 bytes.', 400);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(partialPath, sourcePath);
    await chmod(sourcePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const record = { id, displayName: cleanDisplayName(displayName), mediaType, size, sha256: hash.digest('hex'), origin: provenance ? 'derived' : 'uploaded', operation: provenance, createdAt: new Date().toISOString() };
  state.documents.set(id, { ...record, sourcePath, directory });
  return freezeRecord(record);
}

export function getDocument(state, id) {
  assertOpaqueId(id);
  const record = state.documents.get(id);
  if (!record) throw new HostError('DOCUMENT_NOT_FOUND', 'The local document session was not found.', 404);
  return freezeRecord({ id: record.id, displayName: record.displayName, mediaType: record.mediaType, size: record.size, sha256: record.sha256, origin: record.origin, operation: record.operation, createdAt: record.createdAt });
}

export function getSourcePath(state, id) {
  getDocument(state, id);
  return state.documents.get(id).sourcePath;
}

export async function verifySource(state, id) {
  const record = state.documents.get(id);
  getDocument(state, id);
  const current = await digestFile(record.sourcePath);
  if (current !== record.sha256) throw new HostError('SOURCE_INTEGRITY_FAILED', 'The immutable source PDF no longer matches its recorded digest.', 500);
  return true;
}
