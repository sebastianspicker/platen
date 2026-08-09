import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { inspectPdfXfaPresenceAnalysis } from './pdf-xfa-inspection-analyzer.mjs';
import { PDF_XFA_INSPECTION_LIMITS } from './pdf-xfa-inspection-contract.mjs';

export const MAX_PDF_XFA_INSPECTION_JOB_MS = 120_000;

function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function abort(signal) { if (signal?.aborted) host('JOB_CANCELLED', 'XFA inspection was cancelled.', 499); }

async function shape(path) {
  const names = await readdir(path);
  if (names.length !== 1 || names[0] !== 'input.pdf') host('PDF_XFA_INSPECTION_WORKSPACE_INVALID', 'The private XFA inspection workspace contains unexpected files.');
  const stat = await lstat(join(path, 'input.pdf'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) host('PDF_XFA_INSPECTION_WORKSPACE_INVALID', 'The private XFA inspection workspace is unsafe.');
}

export async function runPdfXfaInspectionJob({ store, analyzer, documentId, source, request, deadline, lifecycle }) {
  let sourceBytes;
  try {
    abort(deadline.signal);
    await store.verifySource(documentId);
    const workspace = await store.createJobWorkspace(documentId);
    lifecycle.workspace = workspace;
    const inputPath = join(workspace, 'input.pdf');
    const identity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: PDF_XFA_INSPECTION_LIMITS.maxSourceBytes, signal: deadline.signal });
    await shape(workspace);
    sourceBytes = await readFile(inputPath);
    if (sha(sourceBytes) !== source.sha256) host('SOURCE_INTEGRITY_FAILED', 'The private XFA inspection source changed.', 500);
    abort(deadline.signal);
    const candidate = await analyzer(Buffer.from(sourceBytes), request);
    abort(deadline.signal);
    const proof = inspectPdfXfaPresenceAnalysis(sourceBytes, request, candidate);
    await assertPrivateSourceCopy({ path: inputPath, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: PDF_XFA_INSPECTION_LIMITS.maxSourceBytes });
    await store.verifySource(documentId);
    abort(deadline.signal);
    lifecycle.completed = true;
    return Object.freeze({
      kind: 'pdf-xfa-presence-inspection', xfaPresent: proof.xfaPresent, proof,
      limitations: Object.freeze([
        'This inspection reports only whether the Catalog or a direct Catalog AcroForm dictionary contains an XFA key in one bounded unencrypted classic PDF revision.',
        'Any detected XFA is unsupported. The operation does not dereference, read, render, fill, convert, validate, return, preserve, or otherwise process XFA data.',
      ]),
    });
  } finally { sourceBytes?.fill(0); }
}

export async function cleanupPdfXfaInspectionJob({ store, lifecycle }) {
  if (!lifecycle.workspace) return;
  try { await store.cleanupJob(lifecycle.workspace); } catch (error) { host('PDF_XFA_INSPECTION_CLEANUP_FAILED', 'XFA inspection cleanup failed.', 500, error); }
}
