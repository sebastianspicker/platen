import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { inspectPdfFormJavaScriptAnalysis } from './pdf-form-javascript-analyzer.mjs';
import { PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS } from './pdf-form-javascript-contract.mjs';

export const MAX_PDF_FORM_JAVASCRIPT_JOB_MS = 120_000;
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function abort(signal) { if (signal?.aborted) host('JOB_CANCELLED', 'Form JavaScript inventory was cancelled.', 499); }
async function shape(path) { const names = await readdir(path); if (names.length !== 1 || names[0] !== 'input.pdf') host('PDF_FORM_JAVASCRIPT_WORKSPACE_INVALID', 'The private form JavaScript workspace contains unexpected files.'); const stat = await lstat(join(path, 'input.pdf')); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) host('PDF_FORM_JAVASCRIPT_WORKSPACE_INVALID', 'The private form JavaScript workspace is unsafe.'); }

export async function runPdfFormJavaScriptInventoryJob({ store, analyzer, documentId, source, request, deadline, lifecycle }) {
  let sourceBytes;
  try {
    abort(deadline.signal); await store.verifySource(documentId); const workspace = await store.createJobWorkspace(documentId); lifecycle.workspace = workspace; const inputPath = join(workspace, 'input.pdf');
    const identity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxSourceBytes, signal: deadline.signal });
    await shape(workspace); sourceBytes = await readFile(inputPath); if (sha(sourceBytes) !== source.sha256) host('SOURCE_INTEGRITY_FAILED', 'The private form JavaScript source changed.', 500); abort(deadline.signal);
    const candidate = await analyzer(Buffer.from(sourceBytes), request); abort(deadline.signal); const report = inspectPdfFormJavaScriptAnalysis(sourceBytes, request, candidate);
    await assertPrivateSourceCopy({ path: inputPath, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxSourceBytes }); await store.verifySource(documentId); abort(deadline.signal); lifecycle.completed = true;
    return Object.freeze({ kind: 'pdf-form-javascript-inventory', report, limitations: Object.freeze(['This operation inventories only exact inline JavaScript actions attached to K, F, V, or C triggers on merged terminal text widgets in a narrowly admitted classic PDF subset.', 'It does not expose script text, author, evaluate, execute, mutate, sanitize, or establish trust in any action.', 'Dynamic, chained, shared, indirect-stream, encrypted, signed, XFA, incremental, compressed-object, catalog-level, or otherwise unsupported action structures are rejected rather than partially reported.']) });
  } finally { sourceBytes?.fill(0); }
}

export async function cleanupPdfFormJavaScriptInventoryJob({ store, lifecycle }) { if (!lifecycle.workspace) return; try { await store.cleanupJob(lifecycle.workspace); } catch (error) { host('PDF_FORM_JAVASCRIPT_CLEANUP_FAILED', 'Form JavaScript inventory cleanup failed.', 500, error); } }
