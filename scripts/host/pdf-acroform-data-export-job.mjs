import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { decodeStrictAcroFormExportString, inheritedAcroFormEntry, inspectClassicAcroForm } from './pdf-acroform-validation-core.mjs';
import { createAcroFormDataExportResult } from './pdf-acroform-data-export-contract.mjs';

export const MAX_PDF_ACROFORM_DATA_EXPORT_JOB_MS = 60_000;
export const MAX_PDF_ACROFORM_DATA_EXPORT_SOURCE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_ACROFORM_DATA_EXPORT_SOURCE_COPY = Object.freeze({ stage: stagePrivateSourceCopy, assert: assertPrivateSourceCopy });

function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'AcroForm data export was cancelled.', 499, signal.reason); }
async function readSource(path, size) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size !== BigInt(size) || (metadata.mode & 0o777n) !== 0o400n) fail('ACROFORM_DATA_EXPORT_TAMPERED', 'The private data export source is unsafe.');
    return await handle.readFile();
  } finally { await handle.close(); }
}
function terminalTextField(source) {
  const inspected = inspectClassicAcroForm(source);
  if (inspected.catalog.has('AA') || inspected.catalog.has('Perms') || inspected.acro.has('A') || inspected.acro.has('SigFlags')) fail('ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED', 'Catalog, signature, and form actions are not admitted.', 422);
  if (inspected.fields.length !== 1 || inspected.fields[0].type !== 'Tx') fail('ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED', 'The source must contain exactly one terminal text field.', 422);
  const field = inspected.fields[0]; const name = inheritedAcroFormEntry(field.entries, field.parent, 'T'); const raw = inheritedAcroFormEntry(field.entries, field.parent, 'V');
  if (raw !== undefined && raw?.type !== 'string') fail('ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED', 'The terminal text value is unsupported.', 422);
  try { return Object.freeze({ fieldName: decodeStrictAcroFormExportString(name), currentValue: raw === undefined ? '' : decodeStrictAcroFormExportString(raw) }); }
  catch (error) { fail('ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED', 'The terminal text value is outside the bounded subset.', 422, error); }
}

export async function runAcroFormDataExportJob({ store, documentId, source, deadline, lifecycle, sourceCopy = DEFAULT_ACROFORM_DATA_EXPORT_SOURCE_COPY }) {
  let bytes;
  try {
    abort(deadline.signal); await store.verifySource(documentId); lifecycle.workspace = await store.createJobWorkspace(documentId);
    const sourcePath = join(lifecycle.workspace, 'source.pdf'); const identity = await sourceCopy.stage({ sourcePath: store.getSourcePath(documentId), targetPath: sourcePath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_DATA_EXPORT_SOURCE_BYTES, signal: deadline.signal });
    bytes = await readSource(sourcePath, source.size); await sourceCopy.assert({ path: sourcePath, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_DATA_EXPORT_SOURCE_BYTES }); abort(deadline.signal);
    let field; try { field = terminalTextField(bytes); } catch (error) { if (error instanceof HostError) throw error; fail('ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED', 'The source is outside the bounded passive AcroForm data export subset.', 422, error); }
    let result; try { result = createAcroFormDataExportResult({ sourceSha256: source.sha256, ...field }); } catch (error) { fail('ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED', 'The terminal text field cannot be exported safely as CSV.', 422, error); }
    await sourceCopy.assert({ path: sourcePath, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_DATA_EXPORT_SOURCE_BYTES }); await store.verifySource(documentId); abort(deadline.signal); lifecycle.completed = true;
    return result;
  } finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
}
export async function cleanupAcroFormDataExportJob({ store, lifecycle }) {
  if (!lifecycle.workspace) return;
  try { await store.cleanupJob(lifecycle.workspace); } catch (error) { fail('ACROFORM_DATA_EXPORT_CLEANUP_FAILED', 'AcroForm data export cleanup failed.', 500, error); }
}
