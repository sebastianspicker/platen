import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { types as nodeTypes } from 'node:util';
import { join } from 'node:path';
import { executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { promoteAccessibilityLinksBookmarksArtifact } from './pdf-accessibility-links-bookmarks-artifact.mjs';
import {
  ACCESSIBILITY_LINKS_BOOKMARKS_AFTER_FILES, ACCESSIBILITY_LINKS_BOOKMARKS_BEFORE_FILES,
  MAX_ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_BYTES, MAX_ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_BYTES,
  assertAccessibilityLinksBookmarksProof, assertAccessibilityLinksBookmarksWorkspace,
  readStableAccessibilityLinksBookmarks, writePrivateAccessibilityLinksBookmarksOutput,
} from './pdf-accessibility-links-bookmarks-validation.mjs';

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function aborted(signal) { if (signal.aborted) throw signal.reason ?? new Error('Accessibility links/bookmarks processing was cancelled.'); }
function overlap(left, right) { return left.buffer === right.buffer && left.byteOffset < right.byteOffset + right.byteLength && right.byteOffset < left.byteOffset + left.byteLength; }
function plainSnapshot(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) { if (nodeTypes.isProxy(value)) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks result contains a proxied byte buffer.'); return Buffer.from(value); }
  if (nodeTypes.isProxy(value) || depth > 6 || seen.has(value)) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks result contains cyclic or proxied data.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks result contains a non-plain array.');
      const descriptors = Object.getOwnPropertyDescriptors(value); const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || Object.keys(descriptors).length !== length + 1) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks result contains a sparse array.');
      const copy = []; for (let index = 0; index < length; index += 1) { const descriptor = descriptors[index]; if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks result contains accessor-backed data.'); copy.push(plainSnapshot(descriptor.value, seen, depth + 1)); } return Object.freeze(copy);
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks result contains a non-plain object.');
    const descriptors = Object.getOwnPropertyDescriptors(value); const copy = {};
    for (const [key, descriptor] of Object.entries(descriptors)) { if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks result contains accessor-backed data.'); copy[key] = plainSnapshot(descriptor.value, seen, depth + 1); }
    return Object.freeze(copy);
  } catch (error) { if (error?.code === 'ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID') throw error; fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks result could not be inspected.'); } finally { seen.delete(value); }
}
function checkedWriteResult(value) {
  const snapshot = plainSnapshot(value); const keys = Object.keys(snapshot);
  if (keys.length !== 2 || !keys.includes('bytes') || !keys.includes('proof') || !Buffer.isBuffer(snapshot.bytes) || nodeTypes.isProxy(snapshot.bytes)) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The raw links/bookmarks writer returned an invalid result.');
  return snapshot;
}

export async function runAccessibilityLinksBookmarksJob({ store, core, documentId, source, request, deadline, lifecycle }) {
  aborted(deadline.signal); await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace);
  const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
  const inputIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_BYTES, signal: deadline.signal });
  await assertAccessibilityLinksBookmarksWorkspace(workspace, ACCESSIBILITY_LINKS_BOOKMARKS_BEFORE_FILES);
  lifecycle.sourceBytes = await readStableAccessibilityLinksBookmarks(inputPath, MAX_ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_BYTES);
  if (lifecycle.sourceBytes.length !== source.size) fail('SOURCE_INTEGRITY_FAILED', 'The private links/bookmarks source changed before parsing.');
  aborted(deadline.signal);
  const writtenResult = checkedWriteResult(core.writePdfAccessibilityLinksBookmarks(lifecycle.sourceBytes, request)); let written = writtenResult; let writtenBytes = written.bytes; let writtenProof;
  try {
    if (!Buffer.isBuffer(writtenBytes) || overlap(writtenBytes, lifecycle.sourceBytes) || !written?.proof) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The raw links/bookmarks writer returned an invalid result.');
    assertAccessibilityLinksBookmarksProof(written.proof, lifecycle.sourceBytes.length, writtenBytes.length, request); writtenProof = written.proof;
    if (!writtenBytes.subarray(0, lifecycle.sourceBytes.length).equals(lifecycle.sourceBytes)) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The raw links/bookmarks writer changed the source prefix.');
    await writePrivateAccessibilityLinksBookmarksOutput(outputPath, writtenBytes);
  } finally { if (Buffer.isBuffer(writtenBytes) && !overlap(writtenBytes, lifecycle.sourceBytes)) writtenBytes.fill(0); writtenBytes = null; written = null; }
  await assertAccessibilityLinksBookmarksWorkspace(workspace, ACCESSIBILITY_LINKS_BOOKMARKS_AFTER_FILES);
  lifecycle.outputBytes = await readStableAccessibilityLinksBookmarks(outputPath);
  const proof = core.inspectPdfAccessibilityLinksBookmarks(lifecycle.sourceBytes, lifecycle.outputBytes, request);
  assertAccessibilityLinksBookmarksProof(proof, lifecycle.sourceBytes.length, lifecycle.outputBytes.length, request);
  if (!isDeepStrictEqual(writtenProof, proof) || !lifecycle.outputBytes.subarray(0, lifecycle.sourceBytes.length).equals(lifecycle.sourceBytes)) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'Separate raw links/bookmarks reinspection disagreed with the writer proof.');
  await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_BYTES });
  await store.verifySource(documentId); aborted(deadline.signal);
  const outputSha256 = createHash('sha256').update(lifecycle.outputBytes).digest('hex'); if (outputSha256 === source.sha256) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The links/bookmarks output did not produce a distinct artifact digest.');
  const promoted = plainSnapshot(await promoteAccessibilityLinksBookmarksArtifact({ store, documentId, source, outputPath, outputSha256, request, evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, rawReinspectionPassed: true, hierarchyPreserved: true, geometryPreserved: true }, signal: deadline.signal }));
  const artifact = promoted.artifact;
  if (!artifact || Object.getPrototypeOf(artifact) !== Object.prototype
    || typeof artifact.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(artifact.id)
    || artifact.id === source.id || artifact.documentId !== documentId || artifact.mediaType !== 'application/pdf'
    || artifact.sha256 !== outputSha256 || artifact.size !== lifecycle.outputBytes.length
    || typeof artifact.displayName !== 'string' || !artifact.displayName.endsWith('-links-bookmarks.pdf')
    || !isDeepStrictEqual(artifact.operation, promoted.operation)) fail('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The promoted links/bookmarks artifact identity is invalid.');
  lifecycle.promotedArtifact = promoted;
  await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_BYTES });
  await store.verifySource(documentId);
  aborted(deadline.signal); lifecycle.completed = true; return lifecycle.promotedArtifact;
}
