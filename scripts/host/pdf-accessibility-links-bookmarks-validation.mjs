import { chmod, lstat, open, readdir, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { types as nodeTypes } from 'node:util';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';

export const MAX_ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_BYTES = MAX_ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_BYTES + 1024 * 1024;
export const ACCESSIBILITY_LINKS_BOOKMARKS_BEFORE_FILES = Object.freeze(['input.pdf']);
export const ACCESSIBILITY_LINKS_BOOKMARKS_AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const PROOF_KEYS = Object.freeze(['profile', 'sourceBytes', 'outputBytes', 'appendedBytes', 'sourcePrefixPreserved', 'revisionCount', 'sourceRevisionCount', 'previousXrefOffset', 'appendedXrefOffset', 'links', 'bookmarks', 'updatedObjectNumbers', 'effectiveSize', 'rootPreserved', 'infoPreserved', 'hierarchyPreserved', 'geometryPreserved', 'idPolicy']);

function fail(code, message, status = 502) { throw new HostError(code, message, status); }
export async function assertAccessibilityLinksBookmarksWorkspace(workspace, expected) {
  const entries = (await readdir(workspace)).sort(); if (!isDeepStrictEqual(entries, [...expected].sort())) fail('ACCESSIBILITY_LINKS_BOOKMARKS_WORKSPACE_INVALID', 'Accessibility links/bookmarks processing changed its private workspace topology.');
  for (const entry of entries) { const stat = await lstat(join(workspace, entry)); if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail('ACCESSIBILITY_LINKS_BOOKMARKS_WORKSPACE_INVALID', 'Accessibility links/bookmarks processing produced an unsafe workspace file.'); }
}
export async function writePrivateAccessibilityLinksBookmarksOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_BYTES) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The raw links/bookmarks writer returned an invalid bounded PDF buffer.');
  let handle;
  try { handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400); } catch (error) { await handle?.close().catch(() => {}); await unlink(path).catch(() => {}); fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks output could not be staged privately.', 502, error); }
}
export async function readStableAccessibilityLinksBookmarks(path, maximumBytes = MAX_ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_BYTES) {
  let handle = null; let bytes = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n || before.size < 64n || before.size > BigInt(maximumBytes)) fail('ACCESSIBILITY_LINKS_BOOKMARKS_WORKSPACE_INVALID', 'A links/bookmarks workspace file is unsafe.');
    bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (result.bytesRead < 1) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'A links/bookmarks workspace PDF ended during its descriptor-bound read.'); offset += result.bytesRead; }
    const trailing = Buffer.alloc(1); if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'A links/bookmarks workspace PDF grew during its descriptor-bound read.');
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('ACCESSIBILITY_LINKS_BOOKMARKS_WORKSPACE_INVALID', 'A links/bookmarks workspace PDF changed during its descriptor-bound read.');
    return bytes;
  } catch (error) { bytes?.fill(0); throw error; } finally { await handle?.close().catch(() => {}); }
}
function safeProofValue(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4 || seen.has(value) || nodeTypes.isProxy(value)) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks proof contains cyclic or hostile data.');
  seen.add(value);
  try {
    if (Object.getPrototypeOf(value) === Array.prototype) {
      const descriptors = Object.getOwnPropertyDescriptors(value); const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || Object.keys(descriptors).length !== length + 1) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks proof contains a sparse or accessor-backed array.');
      for (let index = 0; index < length; index += 1) { const descriptor = descriptors[index]; if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks proof contains an accessor-backed array.'); safeProofValue(descriptor.value, seen, depth + 1); }
    } else if (Object.getPrototypeOf(value) === Object.prototype) {
      const descriptors = Object.getOwnPropertyDescriptors(value); for (const [key, descriptor] of Object.entries(descriptors)) { if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks proof contains accessor-backed data.'); if (descriptor.value && typeof descriptor.value === 'object') safeProofValue(descriptor.value, seen, depth + 1); }
    } else fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks proof contains a non-plain value.');
  } catch (error) { if (error instanceof HostError) throw error; fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks proof could not be inspected.'); }
  seen.delete(value); return value;
}
export function assertAccessibilityLinksBookmarksProof(proof, sourceLength, outputLength, request) {
  safeProofValue(proof);
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
  const valid = keys.length === PROOF_KEYS.length
    && keys.every((key, index) => key === PROOF_KEYS[index])
    && proof.profile === request.profile && proof.sourceBytes === sourceLength
    && proof.outputBytes === outputLength && proof.appendedBytes === outputLength - sourceLength
    && proof.appendedBytes > 0 && proof.appendedBytes <= 1024 * 1024
    && proof.sourcePrefixPreserved === true && proof.revisionCount === proof.sourceRevisionCount + 1
    && proof.sourceRevisionCount === 1 && Number.isSafeInteger(proof.previousXrefOffset)
    && proof.previousXrefOffset > 0 && proof.previousXrefOffset < sourceLength
    && Number.isSafeInteger(proof.appendedXrefOffset) && proof.appendedXrefOffset >= sourceLength
    && proof.appendedXrefOffset < outputLength && Array.isArray(proof.links)
    && proof.links.length === request.links.length && Array.isArray(proof.bookmarks)
    && proof.bookmarks.length === request.bookmarks.length && Array.isArray(proof.updatedObjectNumbers)
    && proof.updatedObjectNumbers.length === request.links.length + request.bookmarks.length
    && Number.isSafeInteger(proof.effectiveSize) && proof.effectiveSize > 1
    && proof.rootPreserved === true && proof.infoPreserved === true
    && proof.hierarchyPreserved === true && proof.geometryPreserved === true
    && ['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy);
  if (!valid) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The raw links/bookmarks proof did not match the fixed append-only contract.');
  return proof;
}
