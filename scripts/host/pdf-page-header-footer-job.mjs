import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { PDF_PAGE_HEADER_FOOTER_LIMITS, PDF_PAGE_HEADER_FOOTER_PROFILE } from './pdf-page-header-footer-contract.mjs';
import { inspectPdfPageHeaderFooter, writePdfPageHeaderFooter } from './pdf-page-header-footer-writer.mjs';
import { PDF_PAGE_HEADER_FOOTER_LIMITATIONS } from '../../src/core/pdf-page-header-footer-contract.js';

export const MAX_PDF_PAGE_HEADER_FOOTER_JOB_MS = 120_000;
export const MAX_PDF_PAGE_HEADER_FOOTER_SOURCE_BYTES = PDF_PAGE_HEADER_FOOTER_LIMITS.maxSourceBytes;
export const MAX_PDF_PAGE_HEADER_FOOTER_OUTPUT_BYTES = MAX_PDF_PAGE_HEADER_FOOTER_SOURCE_BYTES + 512 * 1024;
const CORE = Object.freeze({ writePdfPageHeaderFooter, inspectPdfPageHeaderFooter });
const IDENTITY = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Page header/footer processing was cancelled.', 499); }
function same(a, b) { return IDENTITY.every((key) => a[key] === b[key]); }
async function names(workspace) { return (await readdir(workspace, { withFileTypes: true })).map((entry) => entry.name).sort(); }
async function readPrivate(path, identity, expectedSha256, expectedSize, maximum) { let handle; try { handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const before = await handle.stat({ bigint: true }); if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n || before.size !== BigInt(expectedSize) || !same(before, identity)) fail('PDF_PAGE_HEADER_FOOTER_WORKSPACE_INVALID', 'Private header/footer workspace file changed.'); const bytes = await handle.readFile(); if (bytes.length !== expectedSize || bytes.length > maximum || digest(bytes) !== expectedSha256 || !same(before, await handle.stat({ bigint: true }))) fail('PDF_PAGE_HEADER_FOOTER_WORKSPACE_INVALID', 'Private header/footer workspace file changed while reading.'); return bytes; } finally { await handle?.close().catch(() => {}); } }
async function writePrivate(path, bytes) { let handle; try { if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_PDF_PAGE_HEADER_FOOTER_OUTPUT_BYTES) fail('PDF_PAGE_HEADER_FOOTER_OUTPUT_INVALID', 'Writer returned an invalid bounded PDF output.'); handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400); handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const stat = await handle.stat({ bigint: true }); return Object.freeze(Object.fromEntries(IDENTITY.map((key) => [key, stat[key]]))); } catch (error) { await unlink(path).catch(() => {}); if (error instanceof HostError) throw error; fail('PDF_PAGE_HEADER_FOOTER_OUTPUT_INVALID', 'Header/footer output could not be staged privately.', 502, error); } finally { await handle?.close().catch(() => {}); } }

export async function runPdfPageHeaderFooterJob({ store, documentId, source, request, deadline, lifecycle, core = CORE }) {
  let written; abort(deadline.signal); await store.verifySource(documentId); const workspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace); const input = join(workspace, 'input.pdf'); const output = join(workspace, 'output.pdf');
  try {
    if (JSON.stringify(await names(workspace)) !== '[]') fail('PDF_PAGE_HEADER_FOOTER_WORKSPACE_INVALID', 'Private workspace was not empty.');
    const inputIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: input, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_PAGE_HEADER_FOOTER_SOURCE_BYTES, signal: deadline.signal });
    lifecycle.sourceBytes = await readPrivate(input, inputIdentity, source.sha256, source.size, MAX_PDF_PAGE_HEADER_FOOTER_SOURCE_BYTES); await assertPrivateSourceCopy({ path: input, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_PAGE_HEADER_FOOTER_SOURCE_BYTES }); abort(deadline.signal);
    written = core.writePdfPageHeaderFooter(lifecycle.sourceBytes, request); if (!written?.proof || !Buffer.isBuffer(written.bytes) || !written.bytes.subarray(0, lifecycle.sourceBytes.length).equals(lifecycle.sourceBytes)) fail('PDF_PAGE_HEADER_FOOTER_OUTPUT_INVALID', 'Writer did not preserve the source prefix.');
    const outputSize = written.bytes.length;
    const outputSha256 = digest(written.bytes);
    const outputIdentity = await writePrivate(output, written.bytes);
    written.bytes.fill(0);
    lifecycle.outputBytes = await readPrivate(output, outputIdentity, outputSha256, outputSize, MAX_PDF_PAGE_HEADER_FOOTER_OUTPUT_BYTES);
    await assertPrivateSourceCopy({ path: input, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_PAGE_HEADER_FOOTER_SOURCE_BYTES });
    const proof = core.inspectPdfPageHeaderFooter(lifecycle.sourceBytes, lifecycle.outputBytes, request);
    if (JSON.stringify(proof) !== JSON.stringify(written.proof)) fail('PDF_PAGE_HEADER_FOOTER_OUTPUT_INVALID', 'Independent reinspection disagreed with writer proof.');
    lifecycle.outputBytes.fill(0);
    lifecycle.outputBytes = await readPrivate(output, outputIdentity, outputSha256, outputSize, MAX_PDF_PAGE_HEADER_FOOTER_OUTPUT_BYTES);
    const finalProof = core.inspectPdfPageHeaderFooter(lifecycle.sourceBytes, lifecycle.outputBytes, request);
    if (JSON.stringify(finalProof) !== JSON.stringify(proof) || JSON.stringify(await names(workspace)) !== JSON.stringify(['input.pdf', 'output.pdf'])) fail('PDF_PAGE_HEADER_FOOTER_OUTPUT_INVALID', 'Retained output reinspection failed.');
    await store.verifySource(documentId);
    abort(deadline.signal);
    const operation = createOperationProvenance({ type: 'pdf-page-header-footer', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_PAGE_HEADER_FOOTER_PROFILE, pages: request.pages, headerSha256: digest(Buffer.from(request.header, 'utf8')), footerPrefixSha256: digest(Buffer.from(request.footerPrefix, 'utf8')) }, expected: { sourcePrefixPreserved: true, outputSha256 }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'header-footer-writer', 'independent-reinspection', 'artifact-sha256'], outputSha256 } });
    lifecycle.promotedArtifact = { artifact: await store.promotePdfArtifact(documentId, output, { displayName: 'page-header-footer.pdf', operation, expectedSha256: outputSha256, signal: deadline.signal }) }; if (!lifecycle.promotedArtifact.artifact || lifecycle.promotedArtifact.artifact.sha256 !== outputSha256 || lifecycle.promotedArtifact.artifact.size !== outputSize) fail('PDF_PAGE_HEADER_FOOTER_OUTPUT_INVALID', 'Promoted artifact identity did not match retained output.'); try { abort(deadline.signal); } catch (error) { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); lifecycle.promotedArtifact = null; throw error; } lifecycle.completed = true; return Object.freeze({ artifact: lifecycle.promotedArtifact.artifact, proof: finalProof, limitations: PDF_PAGE_HEADER_FOOTER_LIMITATIONS });
  } finally { lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); written?.bytes?.fill(0); }
}
export async function cleanupPdfPageHeaderFooterJob({ store, lifecycle }) { const results = await Promise.allSettled((lifecycle.workspaces ?? []).reverse().map((workspace) => store.cleanupJob(workspace))); let failed = results.some((item) => item.status === 'rejected'); if ((!lifecycle.completed || failed) && lifecycle.promotedArtifact?.artifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { failed = true; } } if (failed) fail('PDF_PAGE_HEADER_FOOTER_CLEANUP_FAILED', 'Header/footer processing could not clean its private workspace.', 500); }
