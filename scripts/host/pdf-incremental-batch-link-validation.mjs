import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import { PNG_SIGNATURE, readRegularOutput } from './pdf-service-foundation.mjs';
import { incrementalMetadataEnvelopeSupported, inspectIncrementalMetadataContent, inspectIncrementalMetadataEnvelope, incrementalMetadataRunOptions, incrementalMetadataFileIdentity } from './pdf-incremental-metadata-validation.mjs';

export const MAX_INCREMENTAL_BATCH_LINK_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_INCREMENTAL_BATCH_LINK_OUTPUT_BYTES = MAX_INCREMENTAL_BATCH_LINK_SOURCE_BYTES + 2 * 1024 * 1024;
export const BATCH_LINK_BEFORE_FILES = Object.freeze(['input.pdf']);
export const BATCH_LINK_AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const KEYS = Object.freeze(['profile', 'sourceBytes', 'outputBytes', 'appendedBytes', 'sourcePrefixPreserved', 'revisionCount', 'previousXrefOffset', 'appendedXrefOffset', 'links', 'updatedPageObjectNumbers', 'updatedObjectNumbers', 'effectiveSize', 'rootPreserved', 'infoPreserved', 'idPolicy']);
const STABLE_INFO_FIELDS = Object.freeze(['pageCount', 'title', 'author', 'subject', 'keywords', 'creator', 'producer', 'createdAt', 'modifiedAt', 'tagged', 'userProperties', 'suspects', 'form', 'javascript', 'encrypted', 'pageSize', 'pageRotation', 'optimized', 'pdfVersion']);
function fail(code, message, status = 502) { throw new HostError(code, message, status); }
export { incrementalMetadataEnvelopeSupported as incrementalBatchLinkEnvelopeSupported, inspectIncrementalMetadataEnvelope as inspectIncrementalBatchLinkEnvelope };
export const incrementalBatchLinkFileIdentity = incrementalMetadataFileIdentity;
export async function assertIncrementalBatchLinkFileIdentity(path, expected) { if (!isDeepStrictEqual(await incrementalBatchLinkFileIdentity(path), expected)) fail('INCREMENTAL_BATCH_LINK_WORKSPACE_INVALID', 'A batch-link workspace file changed during validation.'); }
export async function inspectIncrementalBatchLinkContent(poppler, input, workspace, signal, pageCount) { return inspectIncrementalMetadataContent(poppler, input, workspace, signal, pageCount); }
export function incrementalBatchLinkEnvelopeMatches(source, output) { return STABLE_INFO_FIELDS.every((field) => source.inspection[field] === output.inspection[field]) && ['xmp', 'custom', 'attachments', 'urls'].every((field) => isDeepStrictEqual(source[field], output[field])); }
function integer(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function exactProofKeys(keys) { return keys.length === KEYS.length && keys.every((key, index) => key === KEYS[index]); }
function linksValid(proof, request) {
  return Array.isArray(proof?.links) && proof.links.length === request.links.length
    && proof.links.every((link, index) => link.sourcePage === request.links[index].sourcePage
      && link.targetPage === request.links[index].targetPage
      && isDeepStrictEqual(link.rect, request.links[index].rect)
      && integer(link.sourcePageObjectNumber, 1, proof.effectiveSize - 1)
      && integer(link.targetPageObjectNumber, 1, proof.effectiveSize - 1)
      && integer(link.linkAnnotationObjectNumber, 1, proof.effectiveSize - 1));
}
function proofIdentityAndBytesValid(proof, sourceLength, outputLength, request) {
  return proof.profile === request.profile && proof.sourceBytes === sourceLength
    && proof.outputBytes === outputLength && proof.appendedBytes === outputLength - sourceLength;
}
function byteBoundsValid(sourceLength, outputLength) {
  return integer(sourceLength, 5, MAX_INCREMENTAL_BATCH_LINK_SOURCE_BYTES)
    && integer(outputLength, sourceLength + 1, MAX_INCREMENTAL_BATCH_LINK_OUTPUT_BYTES);
}
function revisionProofValid(proof, sourceLength, outputLength) {
  return proof.sourcePrefixPreserved === true && integer(proof.revisionCount, 2, 32)
    && integer(proof.previousXrefOffset, 1, sourceLength - 1)
    && integer(proof.appendedXrefOffset, sourceLength, outputLength - 1);
}
function updatedPageObjectsValid(proof) {
  return Array.isArray(proof.updatedPageObjectNumbers) && proof.updatedPageObjectNumbers.length >= 1
    && proof.updatedPageObjectNumbers.every((value) => integer(value, 1, proof.effectiveSize - 1));
}
function updatedObjectsValid(proof) {
  return Array.isArray(proof.updatedObjectNumbers) && proof.updatedObjectNumbers.length >= 1
    && proof.updatedObjectNumbers.every((value) => integer(value, 1, proof.effectiveSize - 1));
}
function proofTailValid(proof) {
  return integer(proof.effectiveSize, 2, 999_999) && proof.rootPreserved === true
    && proof.infoPreserved === true && ['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy);
}
export function assertIncrementalBatchLinkProof(proof, sourceLength, outputLength, request) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
  const validLinks = linksValid(proof, request);
  const valid = exactProofKeys(keys)
    && proofIdentityAndBytesValid(proof, sourceLength, outputLength, request)
    && byteBoundsValid(sourceLength, outputLength)
    && revisionProofValid(proof, sourceLength, outputLength)
    && validLinks
    && updatedPageObjectsValid(proof)
    && updatedObjectsValid(proof)
    && proofTailValid(proof);
  if (!valid) fail('INCREMENTAL_BATCH_LINK_OUTPUT_INVALID', 'The raw batch-link proof did not match the fixed append-only contract.');
  return proof;
}
export async function assertBatchLinkWorkspace(workspace, expected) { const entries = (await readdir(workspace)).sort(); if (!isDeepStrictEqual(entries, [...expected].sort())) fail('INCREMENTAL_BATCH_LINK_WORKSPACE_INVALID', 'Batch-link processing changed its private workspace topology.'); for (const entry of entries) { const stat = await lstat(join(workspace, entry)); if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail('INCREMENTAL_BATCH_LINK_WORKSPACE_INVALID', 'Batch-link processing produced an unsafe workspace file.'); } }
export async function writePrivateIncrementalBatchLinkOutput(path, bytes) { if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_INCREMENTAL_BATCH_LINK_OUTPUT_BYTES) fail('INCREMENTAL_BATCH_LINK_OUTPUT_INVALID', 'The batch-link writer returned an invalid bounded PDF buffer.'); let handle; try { handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; } catch { await handle?.close().catch(() => {}); await unlink(path).catch(() => {}); fail('INCREMENTAL_BATCH_LINK_OUTPUT_INVALID', 'The batch-link output could not be staged privately.'); } }
export async function readStableIncrementalBatchLink(path, maximumBytes = MAX_INCREMENTAL_BATCH_LINK_OUTPUT_BYTES) { return readRegularOutput(path, { minimumBytes: 64, maximumBytes, label: 'Incremental batch-link PDF' }); }
export function incrementalBatchLinkContentMatches(source, output) { return isDeepStrictEqual(source, output); }
async function render(poppler, input, prefix, workspace, signal, page) { const result = await poppler.execute('renderPagePng', { input, outputPrefix: prefix, page, maxDimension: 256 }, incrementalMetadataRunOptions(workspace, signal, 64 * 1024)); if (String(result?.stderr ?? '').trim()) fail('INCREMENTAL_BATCH_LINK_POPPLER_WARNING', 'Poppler reported a warning while validating the batch-link PDF.', 422); const bytes = await readRegularOutput(`${prefix}.png`, { minimumBytes: PNG_SIGNATURE.length, maximumBytes: 32 * 1024 * 1024, label: 'Batch-link validation render' }); if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail('INCREMENTAL_BATCH_LINK_OUTPUT_INVALID', 'Poppler produced an invalid batch-link render.'); return bytes; }
export async function assertIncrementalBatchLinkRendersMatch({ poppler, sourcePath, outputPath, workspace, signal, pageCount }) { for (let page = 1; page <= pageCount; page += 1) { const sourcePrefix = join(workspace, `source-render-${page}`); const outputPrefix = join(workspace, `output-render-${page}`); try { const [source, output] = await Promise.all([render(poppler, sourcePath, sourcePrefix, workspace, signal, page), render(poppler, outputPath, outputPrefix, workspace, signal, page)]); if (!source.equals(output)) fail('INCREMENTAL_BATCH_LINK_OUTPUT_INVALID', `Batch-link changed the 256-pixel validation render of page ${page}.`); } finally { await Promise.allSettled([unlink(`${sourcePrefix}.png`), unlink(`${outputPrefix}.png`)]); } } }
