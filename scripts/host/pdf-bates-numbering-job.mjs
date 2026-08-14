import { createHash } from 'node:crypto';
import { chmod, lstat, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { assertWorkspaceQuota } from './workspace-job-runtime.mjs';
import { inspectPdfBatesNumbering, PDF_BATES_NUMBERING_PROFILE, writePdfBatesNumbering } from './pdf-bates-numbering-writer.mjs';
export const MAX_PDF_BATES_NUMBERING_JOB_MS = 120_000;
export const MAX_PDF_BATES_NUMBERING_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_BATES_NUMBERING_OUTPUT_BYTES = MAX_PDF_BATES_NUMBERING_SOURCE_BYTES + 512 * 1024;
function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined);
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex');
}
function samePrivateMetadata(left, right) { return ['dev', 'ino', 'size', 'nlink', 'mode', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]); }
async function privateRead(path, size, mode, max) { const h = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
try { const s = await h.stat({ bigint: true });
if (!s.isFile() || s.nlink !== 1n || s.size !== BigInt(size) || s.size > BigInt(max) || (s.mode & 0o777n) !== BigInt(mode)) fail('BATES_TAMPERED', 'Private Bates file metadata changed.');
const b = await h.readFile();
const a = await h.stat({ bigint: true });
if (b.length !== size || !samePrivateMetadata(s, a)) fail('BATES_TAMPERED', 'Private Bates file changed during read.');
return { bytes: b, identity: s };
} finally { await h.close();
} }
async function assertWorkspaceInventory(workspace) { await assertWorkspaceQuota(workspace, MAX_PDF_BATES_NUMBERING_OUTPUT_BYTES + MAX_PDF_BATES_NUMBERING_SOURCE_BYTES);
const entries = await readdir(workspace, { withFileTypes: true });
if (entries.length !== 2 || entries.some((entry) => !entry.isFile() || !['source.pdf', 'output.pdf'].includes(entry.name))) fail('BATES_WORKSPACE_INVALID', 'Bates workspace inventory changed.');
}
function throwIfCancelled(deadline) { if (deadline.signal.aborted) fail('JOB_CANCELLED', 'Bates numbering was cancelled.', 499); }
export async function runPdfBatesNumberingJob({ store, documentId, source, request, deadline, lifecycle }) { let sourceRead = null; let built = null; let outputRead = null;
try { throwIfCancelled(deadline);
await store.verifySource(documentId);
throwIfCancelled(deadline);
const workspace = await store.createJobWorkspace(documentId);
lifecycle.workspace = workspace;
const input = join(workspace, 'source.pdf');
const identity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: input, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_BATES_NUMBERING_SOURCE_BYTES, signal: deadline.signal });
throwIfCancelled(deadline);
sourceRead = await privateRead(input, source.size, 0o400, MAX_PDF_BATES_NUMBERING_SOURCE_BYTES);
await assertPrivateSourceCopy({ path: input, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_BATES_NUMBERING_SOURCE_BYTES });
throwIfCancelled(deadline);
built = writePdfBatesNumbering(sourceRead.bytes, request);
if (built.bytes.length > MAX_PDF_BATES_NUMBERING_OUTPUT_BYTES) fail('BATES_OUTPUT_INVALID', 'Bates output exceeds its bound.');
const output = join(workspace, 'output.pdf');
await writeFile(output, built.bytes, { mode: 0o600, flag: 'wx' });
await chmod(output, 0o600);
await assertWorkspaceInventory(workspace);
throwIfCancelled(deadline);
outputRead = await privateRead(output, built.bytes.length, 0o600, MAX_PDF_BATES_NUMBERING_OUTPUT_BYTES);
inspectPdfBatesNumbering(sourceRead.bytes, outputRead.bytes, request);
await assertPrivateSourceCopy({ path: input, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_BATES_NUMBERING_SOURCE_BYTES });
await store.verifySource(documentId);
throwIfCancelled(deadline);
outputRead.bytes.fill(0);
outputRead = await privateRead(output, built.bytes.length, 0o600, MAX_PDF_BATES_NUMBERING_OUTPUT_BYTES);
const finalInspected = inspectPdfBatesNumbering(sourceRead.bytes, outputRead.bytes, request);
await assertWorkspaceInventory(workspace);
const outputSha256 = digest(outputRead.bytes);
const operation = createOperationProvenance({ type: 'pdf-bates-numbering', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_BATES_NUMBERING_PROFILE, pages: request.pages, position: request.position, padding: request.padding }, expected: { outputSha256, sourcePrefixPreserved: true }, validation: { passed: true, validators: ['source-sha256', 'private-stage', 'workspace-inventory', 'bates-writer', 'independent-reinspection'], outputSha256 } });
lifecycle.promotedArtifact = await store.promotePdfArtifact(documentId, output, { displayName: 'bates-numbered.pdf', operation, expectedSha256: outputSha256, signal: deadline.signal });
if (!lifecycle.promotedArtifact || typeof lifecycle.promotedArtifact.id !== 'string' || lifecycle.promotedArtifact.documentId !== documentId
  || lifecycle.promotedArtifact.sha256 !== outputSha256 || lifecycle.promotedArtifact.size !== outputRead.bytes.length) fail('BATES_PROMOTION_INVALID', 'Promoted Bates artifact identity did not match the validated output.');
try { throwIfCancelled(deadline); } catch (error) { try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (revokeError) { fail('BATES_CLEANUP_FAILED', 'Promoted Bates artifact could not be revoked after cancellation.', 500, revokeError); } lifecycle.promotedArtifact = null; throw error; }
lifecycle.completed = true;
return Object.freeze({ artifact: lifecycle.promotedArtifact, proof: finalInspected, limitations: Object.freeze(['Only passive Bates text numbering is added; source forms, actions, tags, layers, signatures, and unsupported structures are rejected.']) });
} finally { for (const bytes of [sourceRead?.bytes, built?.bytes, outputRead?.bytes]) if (Buffer.isBuffer(bytes)) bytes.fill(0); }
}
export async function cleanupPdfBatesNumberingJob({ store, lifecycle }) { let error = null;
if (lifecycle.workspace) { try { await store.cleanupJob(lifecycle.workspace);
} catch (e) { error = e;
} } if ((!lifecycle.completed || error) && lifecycle.promotedArtifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (cleanupError) { error ??= cleanupError; } }
if (error) fail('BATES_CLEANUP_FAILED', 'Bates job cleanup failed.', 500, error);
}
