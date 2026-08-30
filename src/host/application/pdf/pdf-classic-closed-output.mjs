import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';

function invalid() {
  const error = new Error('PDF output is not a closed single-revision classic PDF.');
  error.code = 'INVALID_CLOSED_CLASSIC_PDF_OUTPUT';
  return error;
}

function whitespace(byte) { return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32; }

function collectReferences(value, references) {
  if (value?.type === 'ref') { references.push(value); return; }
  if (value?.type === 'array') { for (const entry of value.values) collectReferences(entry, references); return; }
  if (value?.type === 'dict') for (const entry of value.entries.values()) collectReferences(entry, references);
}

function permit(allowed, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > allowed.length) throw invalid();
  allowed.fill(1, start, end);
}

function permitHeader(buffer, allowed) {
  const firstLineEnd = buffer.indexOf(0x0a);
  if (firstLineEnd < 0 || !buffer.subarray(0, firstLineEnd + 1).toString('latin1').match(/^%PDF-(?:1\.[0-7]|2\.0)\r?\n$/)) throw invalid();
  permit(allowed, 0, firstLineEnd + 1);
  let position = firstLineEnd + 1;
  if (buffer[position] === 0x25) {
    const secondLineEnd = buffer.indexOf(0x0a, position);
    if (secondLineEnd < 0) throw invalid();
    permit(allowed, position, secondLineEnd + 1);
  }
}

function validateBodyResidue(structure) {
  const { buffer, revisions, objects } = structure;
  const allowed = Buffer.alloc(buffer.length);
  permitHeader(buffer, allowed);
  const revision = revisions[0];
  permit(allowed, revision.offset, revision.revisionEnd);
  for (const object of objects.values()) permit(allowed, object.start, object.end);
  for (let index = 0; index < buffer.length; index += 1) if (allowed[index] === 0 && !whitespace(buffer[index])) throw invalid();
}

export function verifyClosedClassicPdfOutput(bytes) {
  try {
    if (!Buffer.isBuffer(bytes)) throw invalid();
    const structure = parseClassicPdfStructure(bytes);
    if (structure.revisions.length !== 1) throw invalid();
    const reachable = new Set();
    const pending = [structure.root, ...(structure.info ? [structure.info] : [])];
    while (pending.length > 0) {
      const reference = pending.pop(); const key = `${reference.object}:${reference.generation}`;
      if (reachable.has(key)) continue;
      const object = resolveClassicPdfObject(structure, reference);
      if (object.stream && object.value.entries.get('Type')?.value === 'ObjStm') throw invalid();
      if (object.value.type === 'dict' && object.value.entries.get('Type')?.value === 'XRef') throw invalid();
      reachable.add(key); const references = []; collectReferences(object.value, references); pending.push(...references);
    }
    const live = [...structure.effective.values()].filter(({ status }) => status === 'n');
    if (live.length !== reachable.size || live.some(({ object, generation }) => !reachable.has(`${object}:${generation}`))) throw invalid();
    const parsedLive = [...structure.objects.values()].filter((object) => {
      const entry = structure.effective.get(object.reference.object);
      return entry?.status === 'n' && entry.generation === object.reference.generation && entry.offset === object.reference.offset;
    });
    if (parsedLive.length !== reachable.size || parsedLive.some(({ reference }) => !reachable.has(`${reference.object}:${reference.generation}`))) throw invalid();
    validateBodyResidue(structure);
    return Object.freeze({ revisionCount: 1, reachableObjectCount: reachable.size, parsedObjectCount: parsedLive.length, closed: true });
  } catch (error) {
    if (error?.code === 'INVALID_CLOSED_CLASSIC_PDF_OUTPUT') throw error;
    throw invalid();
  }
}

export async function readClosedClassicPdfOutput(path, expectedIdentity) {
  const pathMetadata = await lstat(path, { bigint: true });
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.nlink !== 1n) throw invalid();
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino
      || Object.keys(expectedIdentity ?? {}).some((key) => before[key] !== expectedIdentity[key])) throw invalid();
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true });
    if (bytes.length !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key])) throw invalid();
    const proof = verifyClosedClassicPdfOutput(bytes);
    return Object.freeze({ bytes, sha256: createHash('sha256').update(bytes).digest('hex'), proof });
  } finally { await handle.close().catch(() => {}); }
}
