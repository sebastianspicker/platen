import { chmod, lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import { PNG_SIGNATURE, readRegularOutput } from './pdf-service-foundation.mjs';
import { incrementalMetadataEnvelopeSupported, inspectIncrementalMetadataContent, inspectIncrementalMetadataEnvelope, incrementalMetadataRunOptions } from './pdf-incremental-metadata-validation.mjs';
import { incrementalMetadataFileIdentity } from './pdf-incremental-metadata-validation.mjs';

export const MAX_INCREMENTAL_GOTO_LINK_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_INCREMENTAL_GOTO_LINK_OUTPUT_BYTES = MAX_INCREMENTAL_GOTO_LINK_SOURCE_BYTES + 1024 * 1024;
export const GOTO_LINK_BEFORE_FILES = Object.freeze(['input.pdf']);
export const GOTO_LINK_AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const KEYS = Object.freeze(['profile', 'sourceBytes', 'outputBytes', 'appendedBytes', 'sourcePrefixPreserved', 'revisionCount', 'previousXrefOffset', 'appendedXrefOffset', 'sourcePage', 'targetPage', 'rect', 'sourcePageObjectNumber', 'targetPageObjectNumber', 'linkAnnotationObjectNumber', 'annotationCount', 'effectiveSize', 'rootPreserved', 'infoPreserved', 'idPolicy']);
const STABLE_INFO_FIELDS = Object.freeze([
  'pageCount', 'title', 'author', 'subject', 'keywords', 'creator', 'producer',
  'createdAt', 'modifiedAt', 'tagged', 'userProperties', 'suspects', 'form',
  'javascript', 'encrypted', 'pageSize', 'pageRotation', 'optimized', 'pdfVersion',
]);
function fail(code, message, status = 502) { throw new HostError(code, message, status); }
export { incrementalMetadataEnvelopeSupported as incrementalGoToLinkEnvelopeSupported, inspectIncrementalMetadataEnvelope as inspectIncrementalGoToLinkEnvelope };
export const incrementalGoToLinkFileIdentity = incrementalMetadataFileIdentity;
export async function assertIncrementalGoToLinkFileIdentity(path, expected) {
  const actual = await incrementalGoToLinkFileIdentity(path);
  if (!isDeepStrictEqual(actual, expected)) {
    fail('INCREMENTAL_GOTO_LINK_WORKSPACE_INVALID', 'An incremental GoTo-link workspace file changed during validation.');
  }
}
export async function inspectIncrementalGoToLinkContent(poppler, input, workspace, signal, pageCount) { return inspectIncrementalMetadataContent(poppler, input, workspace, signal, pageCount); }
export function incrementalGoToLinkEnvelopeMatches(source, output) {
  return STABLE_INFO_FIELDS.every(
    (field) => source.inspection[field] === output.inspection[field],
  ) && ['xmp', 'custom', 'attachments', 'urls'].every(
    (field) => isDeepStrictEqual(source[field], output[field]),
  );
}
export function assertIncrementalGoToLinkProof(proof, sourceLength, outputLength, request) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof) ? Object.keys(proof) : [];
  const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  const valid = keys.length === KEYS.length
    && keys.every((key, index) => key === KEYS[index])
    && proof.profile === request.profile
    && proof.sourceBytes === sourceLength && proof.outputBytes === outputLength
    && proof.appendedBytes === outputLength - sourceLength
    && integer(sourceLength, 5, MAX_INCREMENTAL_GOTO_LINK_SOURCE_BYTES)
    && integer(outputLength, sourceLength + 1, MAX_INCREMENTAL_GOTO_LINK_OUTPUT_BYTES)
    && integer(proof.appendedBytes, 1, 1024 * 1024)
    && proof.sourcePrefixPreserved === true && integer(proof.revisionCount, 2, 32)
    && integer(proof.previousXrefOffset, 1, sourceLength - 1)
    && integer(proof.appendedXrefOffset, sourceLength, outputLength - 1)
    && proof.sourcePage === request.sourcePage && proof.targetPage === request.targetPage
    && isDeepStrictEqual(proof.rect, request.rect)
    && ['sourcePageObjectNumber', 'targetPageObjectNumber', 'linkAnnotationObjectNumber'].every(
      (key) => integer(proof[key], 1, 999_999) && proof[key] < proof.effectiveSize,
    )
    && integer(proof.annotationCount, 1, 51) && integer(proof.effectiveSize, 2, 999_999)
    && proof.rootPreserved === true && proof.infoPreserved === true
    && ['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy);
  if (!valid) fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'The raw incremental GoTo-link proof did not match the fixed append-only contract.');
  return proof;
}
export async function assertGoToLinkWorkspace(workspace, expected) { const entries = (await readdir(workspace)).sort(); if (!isDeepStrictEqual(entries, [...expected].sort())) fail('INCREMENTAL_GOTO_LINK_WORKSPACE_INVALID', 'Incremental GoTo-link processing changed its private workspace topology.'); for (const entry of entries) { const stat = await lstat(join(workspace, entry)); if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail('INCREMENTAL_GOTO_LINK_WORKSPACE_INVALID', 'Incremental GoTo-link processing produced an unsafe workspace file.'); } }
export async function writePrivateIncrementalGoToLinkOutput(path, bytes) { if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_INCREMENTAL_GOTO_LINK_OUTPUT_BYTES) fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'The incremental writer did not return a bounded PDF buffer.'); let handle; try { handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400); } catch { await handle?.close().catch(() => {}); await unlink(path).catch(() => {}); fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'The incremental GoTo-link output could not be staged privately.'); } }
export async function readStableIncrementalGoToLink(path, maximumBytes = MAX_INCREMENTAL_GOTO_LINK_OUTPUT_BYTES) { return readRegularOutput(path, { minimumBytes: 64, maximumBytes, label: 'Incremental GoTo-link PDF' }); }
export function incrementalGoToLinkContentMatches(source, output) { return isDeepStrictEqual(source, output); }
async function render(poppler, input, prefix, workspace, signal, page) { const result = await poppler.execute('renderPagePng', { input, outputPrefix: prefix, page, maxDimension: 256 }, incrementalMetadataRunOptions(workspace, signal, 64 * 1024)); if (String(result?.stderr ?? '').trim()) fail('INCREMENTAL_GOTO_LINK_POPPLER_WARNING', 'Poppler reported a warning while validating the incremental GoTo-link PDF.', 422); const bytes = await readRegularOutput(`${prefix}.png`, { minimumBytes: PNG_SIGNATURE.length, maximumBytes: 32 * 1024 * 1024, label: 'Incremental GoTo-link validation render' }); if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', 'Poppler produced an invalid incremental GoTo-link render.'); return bytes; }
export async function assertIncrementalGoToLinkRendersMatch({ poppler, sourcePath, outputPath, workspace, signal, pageCount }) { for (let page = 1; page <= pageCount; page += 1) { const sourcePrefix = join(workspace, `source-render-${page}`); const outputPrefix = join(workspace, `output-render-${page}`); try { const [source, output] = await Promise.all([render(poppler, sourcePath, sourcePrefix, workspace, signal, page), render(poppler, outputPath, outputPrefix, workspace, signal, page)]); if (!source.equals(output)) fail('INCREMENTAL_GOTO_LINK_OUTPUT_INVALID', `Incremental GoTo-link changed the 256-pixel validation render of page ${page}.`); } finally { await Promise.allSettled([unlink(`${sourcePrefix}.png`), unlink(`${outputPrefix}.png`)]); } } }
