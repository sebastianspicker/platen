import { createHash } from 'node:crypto';
import { chmod, lstat, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { createDeadline } from './workspace-job-runtime.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { inspectPdfAccessibilityFormSemantics, writePdfAccessibilityFormSemantics } from './pdf-accessibility-form-semantics-writer.mjs';
import { PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE } from './pdf-accessibility-form-semantics-contract.mjs';

export const MAX_PDF_ACCESSIBILITY_FORM_SEMANTICS_JOB_MS = 120_000;
export const MAX_PDF_ACCESSIBILITY_FORM_SEMANTICS_SOURCE_BYTES = 32 * 1024 * 1024;
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function abort(signal) { if (signal?.aborted) host('JOB_CANCELLED', 'Accessible form semantics processing was cancelled.', 499); }
async function shape(path, expected) { const names = (await readdir(path)).sort(); if (names.join('\0') !== [...expected].sort().join('\0')) host('PDF_ACCESSIBILITY_FORM_SEMANTICS_TAMPERED', 'The private semantics workspace contains unexpected files.'); for (const name of names) { const stat = await lstat(join(path, name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) host('PDF_ACCESSIBILITY_FORM_SEMANTICS_TAMPERED', 'The private semantics workspace is unsafe.'); } }
async function write(path, bytes) { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await chmod(path, 0o400); }
export async function runPdfAccessibilityFormSemanticsJob({ store, documentId, source, request, deadline, lifecycle }) {
  let sourceBytes; let outputBytes; let built;
  try {
    abort(deadline.signal);
    await store.verifySource(documentId);
    const workspace = await store.createJobWorkspace(documentId);
    lifecycle.workspace = workspace;
    const inputPath = join(workspace, 'input.pdf');
    const outputPath = join(workspace, 'output.pdf');
    const identity = await stagePrivateSourceCopy({
      sourcePath: store.getSourcePath(documentId), targetPath: inputPath,
      expectedSha256: source.sha256, expectedSize: source.size,
      maximumBytes: MAX_PDF_ACCESSIBILITY_FORM_SEMANTICS_SOURCE_BYTES,
      signal: deadline.signal,
    });
    await shape(workspace, ['input.pdf']);
    sourceBytes = await readFile(inputPath);
    if (digest(sourceBytes) !== source.sha256) host('SOURCE_INTEGRITY_FAILED', 'The private source changed before semantics writing.', 500);
    built = writePdfAccessibilityFormSemantics(sourceBytes, request);
    await write(outputPath, built.bytes);
    await shape(workspace, ['input.pdf', 'output.pdf']);
    outputBytes = await readFile(outputPath);
    const proof = inspectPdfAccessibilityFormSemantics(sourceBytes, outputBytes, request);
    if (JSON.stringify(proof) !== JSON.stringify(built.proof)) host('PDF_ACCESSIBILITY_FORM_SEMANTICS_OUTPUT_INVALID', 'Independent semantics inspection disagreed with the writer proof.');
    await assertPrivateSourceCopy({ path: inputPath, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACCESSIBILITY_FORM_SEMANTICS_SOURCE_BYTES });
    await store.verifySource(documentId);
    abort(deadline.signal);
    const outputSha256 = digest(outputBytes);
    const operation = createOperationProvenance({
      type: 'pdf-accessibility-form-semantics',
      inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
      parameters: { profile: PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE, fieldCount: proof.fieldCount, page: proof.page, tabOrder: proof.tabOrder },
      expected: { outputSha256, sourcePrefixPreserved: true, rolePreserved: true },
      validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'raw-form-semantics-proof', 'independent-form-semantics-reinspection', 'output-sha256'], outputSha256 },
    });
    const artifact = await store.promotePdfArtifact(documentId, outputPath, {
      displayName: 'accessible-form-semantics.pdf', operation,
      expectedSha256: outputSha256, signal: deadline.signal,
    });
    if (!artifact || artifact.documentId !== documentId || artifact.sha256 !== outputSha256 || artifact.id === source.id) host('PDF_ACCESSIBILITY_FORM_SEMANTICS_OUTPUT_INVALID', 'The promoted artifact does not match the validated output.');
    lifecycle.promotedArtifact = artifact;
    await store.verifySource(documentId);
    abort(deadline.signal);
    lifecycle.completed = true;
    return Object.freeze({
      kind: 'pdf-accessibility-form-semantics', artifact, proof,
      limitations: Object.freeze([
        'Only one page containing up to 50 direct terminal text, button, or choice fields is supported; field names, tooltips, and structural /Tabs /S order are repaired from explicit human-authored input.',
        'Scripts, actions, XFA, signatures, encryption, tags, layers, inherited/shared/ambiguous field graphs, and PDF/UA or signature-preservation claims are rejected.',
      ]),
    });
  }
  finally { sourceBytes?.fill(0); outputBytes?.fill(0); built?.bytes?.fill(0); }
}
export async function cleanupPdfAccessibilityFormSemanticsJob({ store, lifecycle }) { let workspaceError = null; let artifactError = null; if (lifecycle.workspace) try { await store.cleanupJob(lifecycle.workspace); } catch (error) { workspaceError = error; } if ((!lifecycle.completed || workspaceError) && lifecycle.promotedArtifact?.id) try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (error) { artifactError = error; } if (workspaceError || artifactError) host('PDF_ACCESSIBILITY_FORM_SEMANTICS_CLEANUP_FAILED', 'Accessible form semantics cleanup failed.', 500, workspaceError && artifactError ? new AggregateError([workspaceError, artifactError]) : workspaceError ?? artifactError); }
