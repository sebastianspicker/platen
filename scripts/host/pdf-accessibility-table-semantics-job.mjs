import { createHash } from 'node:crypto';
import { chmod, lstat, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { inspectPdfAccessibilityTableSemantics, writePdfAccessibilityTableSemantics } from './pdf-accessibility-table-semantics-writer.mjs';
import { PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE } from './pdf-accessibility-table-semantics-contract.mjs';

export const MAX_PDF_ACCESSIBILITY_TABLE_SEMANTICS_JOB_MS = 120_000;
export const MAX_PDF_ACCESSIBILITY_TABLE_SEMANTICS_SOURCE_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function abort(signal) { if (signal?.aborted) host('JOB_CANCELLED', 'Table semantics processing was cancelled.', 499); }
async function shape(path, expected) { const names = (await readdir(path)).sort(); if (names.join('\0') !== [...expected].sort().join('\0')) host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_TAMPERED', 'The private table semantics workspace contains unexpected files.'); for (const name of names) { const stat = await lstat(join(path, name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_TAMPERED', 'The private table semantics workspace is unsafe.'); } }
async function write(path, bytes) { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await chmod(path, 0o400); }

export async function runPdfAccessibilityTableSemanticsJob({ store, documentId, source, request, deadline, lifecycle }) {
  let sourceBytes; let outputBytes; let built;
  try {
    abort(deadline.signal); await store.verifySource(documentId);
    const workspace = await store.createJobWorkspace(documentId); lifecycle.workspace = workspace;
    const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
    const identity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACCESSIBILITY_TABLE_SEMANTICS_SOURCE_BYTES, signal: deadline.signal });
    await shape(workspace, ['input.pdf']); sourceBytes = await readFile(inputPath); if (digest(sourceBytes) !== source.sha256) host('SOURCE_INTEGRITY_FAILED', 'The private source changed before table semantics writing.', 500);
    built = writePdfAccessibilityTableSemantics(sourceBytes, request); await write(outputPath, built.bytes); await shape(workspace, ['input.pdf', 'output.pdf']); outputBytes = await readFile(outputPath);
    const proof = inspectPdfAccessibilityTableSemantics(sourceBytes, outputBytes, request); if (JSON.stringify(proof) !== JSON.stringify(built.proof)) host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_OUTPUT_INVALID', 'Independent table semantics inspection disagreed with the writer proof.');
    await assertPrivateSourceCopy({ path: inputPath, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACCESSIBILITY_TABLE_SEMANTICS_SOURCE_BYTES }); await store.verifySource(documentId); abort(deadline.signal);
    const outputSha256 = digest(outputBytes); const operation = createOperationProvenance({ type: 'pdf-accessibility-table-semantics', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE, tableRef: proof.tableRef, rowCount: proof.rowCount, columnCount: proof.columnCount, cellCount: proof.cellCount }, expected: { outputSha256, sourcePrefixPreserved: true }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'raw-table-semantics-proof', 'independent-table-semantics-reinspection', 'output-sha256'], outputSha256 } });
    const artifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: 'accessible-table-semantics.pdf', operation, expectedSha256: outputSha256, signal: deadline.signal });
    if (!artifact || typeof artifact !== 'object' || !UUID.test(String(artifact.id ?? '')) || artifact.id === source.id
      || artifact.documentId !== documentId || artifact.displayName !== 'accessible-table-semantics.pdf'
      || artifact.mediaType !== 'application/pdf' || artifact.size !== outputBytes.length
      || artifact.sha256 !== outputSha256 || !artifact.operation
      || JSON.stringify(artifact.operation) !== JSON.stringify(operation)) host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_OUTPUT_INVALID', 'The promoted artifact identity does not match the validated output.');
    let retained; try { retained = await store.getArtifact(artifact.id); } catch (error) { host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_OUTPUT_INVALID', 'The promoted artifact could not be re-read from the document store.', 502, error); }
    if (!retained || retained.id !== artifact.id || retained.documentId !== documentId || retained.displayName !== artifact.displayName || retained.mediaType !== artifact.mediaType || retained.size !== artifact.size || retained.sha256 !== artifact.sha256 || JSON.stringify(retained.operation) !== JSON.stringify(operation)) host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_OUTPUT_INVALID', 'The promoted artifact store record does not match the validated output.');
    lifecycle.promotedArtifact = artifact; await store.verifySource(documentId); abort(deadline.signal); lifecycle.completed = true;
    return Object.freeze({ kind: 'pdf-accessibility-table-semantics', artifact, proof, limitations: Object.freeze(['Only one existing Table with a complete rectangular TH/TD cell model is supported; human-supplied source-bound locators repair only Scope, Headers, RowSpan, and ColSpan.', 'Scripts, actions, forms, XFA, signatures, encryption, layers, inferred tables, page-content edits, and PDF/UA conformance claims are rejected.']) });
  } finally { sourceBytes?.fill(0); outputBytes?.fill(0); built?.bytes?.fill(0); }
}
export async function cleanupPdfAccessibilityTableSemanticsJob({ store, lifecycle }) { let workspaceError = null; let artifactError = null; if (lifecycle.workspace) try { await store.cleanupJob(lifecycle.workspace); } catch (error) { workspaceError = error; } if ((!lifecycle.completed || workspaceError) && lifecycle.promotedArtifact?.id) try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (error) { artifactError = error; } if (workspaceError || artifactError) host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_CLEANUP_FAILED', 'Table semantics cleanup failed.', 500, workspaceError && artifactError ? new AggregateError([workspaceError, artifactError]) : workspaceError ?? artifactError); }
