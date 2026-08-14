import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { acroFormDigest, inspectClassicAcroForm, validateAcroFormValues } from './pdf-acroform-validation-core.mjs';

export const MAX_PDF_ACROFORM_VALIDATION_JOB_MS = 60_000;
export const MAX_PDF_ACROFORM_VALIDATION_SOURCE_BYTES = 32 * 1024 * 1024;
function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'AcroForm validation was cancelled.', 499, signal.reason); }
async function readSource(path, size) { const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { const metadata = await handle.stat({ bigint: true }); if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size !== BigInt(size) || (metadata.mode & 0o777n) !== 0o400n) fail('ACROFORM_VALIDATION_TAMPERED', 'The private validation source is unsafe.'); return await handle.readFile(); } finally { await handle.close(); } }
export async function runAcroFormValidationJob({ store, documentId, source, request, deadline, lifecycle }) {
  let bytes;
  try {
    abort(deadline.signal); await store.verifySource(documentId); lifecycle.workspace = await store.createJobWorkspace(documentId);
    const sourcePath = join(lifecycle.workspace, 'source.pdf'); const identity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: sourcePath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_VALIDATION_SOURCE_BYTES, signal: deadline.signal });
    bytes = await readSource(sourcePath, source.size); await assertPrivateSourceCopy({ path: sourcePath, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_VALIDATION_SOURCE_BYTES }); abort(deadline.signal);
    let inspected; try { inspected = inspectClassicAcroForm(bytes); } catch (error) { fail('ACROFORM_VALIDATION_SOURCE_UNSUPPORTED', 'The source is outside the bounded passive AcroForm validation subset.', 422, error); }
    const names = new Map(); for (const field of inspected.fields) { if (names.has(field.name)) fail('ACROFORM_VALIDATION_SOURCE_UNSUPPORTED', 'The source has ambiguous terminal field names.', 422); names.set(field.name, field); }
    for (const name of Object.keys(request.values)) { const field = names.get(name); if (!field) fail('ACROFORM_VALIDATION_FIELD_NOT_FOUND', 'A submitted value does not identify an inspected field.', 422); if (field.type === 'Tx' || field.type === 'Ch') { if (typeof request.values[name] !== 'string') fail('INVALID_ACROFORM_VALIDATION_OPTIONS', 'Text and choice validation values must be strings.', 400); } else if (typeof request.values[name] !== 'boolean' && typeof request.values[name] !== 'string') fail('INVALID_ACROFORM_VALIDATION_OPTIONS', 'Button validation values are invalid.', 400); }
    let rawErrors; try { rawErrors = validateAcroFormValues(request.values, request.rules); } catch (error) { fail('INVALID_ACROFORM_VALIDATION_OPTIONS', 'The validation rules are invalid.', 400, error); }
    const errors = Object.freeze(rawErrors.map(({ field, code }) => Object.freeze({ fieldNameSha256: acroFormDigest(Buffer.from(field, 'utf8')), code }))); const recomputed = validateAcroFormValues(request.values, request.rules);
    if (JSON.stringify(rawErrors) !== JSON.stringify(recomputed)) fail('ACROFORM_VALIDATION_OUTPUT_INVALID', 'The validation result was not deterministic.');
    await assertPrivateSourceCopy({ path: sourcePath, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_VALIDATION_SOURCE_BYTES }); await store.verifySource(documentId); abort(deadline.signal); lifecycle.completed = true;
    return Object.freeze({ kind: 'pdf-acroform-validation', sourceDigest: source.sha256, fieldCount: inspected.fields.length, valid: errors.length === 0, errors, limitations: Object.freeze(['Read-only validation for up to 100 existing terminal classic AcroForm fields.', 'No regex rules, mutation, artifact creation, calculations, XFA, actions, JavaScript, signatures, or unsupported PDF graphs are supported.']), localOnly: true });
  } finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
}
export async function cleanupAcroFormValidationJob({ store, lifecycle }) { if (!lifecycle.workspace) return; try { await store.cleanupJob(lifecycle.workspace); } catch (error) { fail('ACROFORM_VALIDATION_CLEANUP_FAILED', 'AcroForm validation cleanup failed.', 500, error); } }
