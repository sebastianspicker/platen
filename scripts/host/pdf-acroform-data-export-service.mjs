import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { PDF_ACROFORM_DATA_EXPORT_PROFILE, snapshotAcroFormDataExportRequest } from './pdf-acroform-data-export-contract.mjs';
import { cleanupAcroFormDataExportJob, DEFAULT_ACROFORM_DATA_EXPORT_SOURCE_COPY, MAX_PDF_ACROFORM_DATA_EXPORT_JOB_MS, MAX_PDF_ACROFORM_DATA_EXPORT_SOURCE_BYTES, runAcroFormDataExportJob } from './pdf-acroform-data-export-job.mjs';
import { createDeadline } from './workspace-job-runtime.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob']);
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function exactOptions(options) {
  if (!options || typeof options !== 'object' || isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some((key) => typeof key !== 'string')) throw new TypeError('AcroForm data export options are invalid.');
  const entries = Object.getOwnPropertyDescriptors(options); const keys = Object.keys(entries);
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'signal') || Object.values(entries).some((entry) => !Object.hasOwn(entry, 'value') || entry.enumerable !== true) || (Object.hasOwn(entries, 'signal') && !(entries.signal.value instanceof AbortSignal))) throw new TypeError('AcroForm data export options are invalid.');
  return entries.signal?.value;
}
function snapshot(request) { try { return snapshotAcroFormDataExportRequest(request); } catch { throw host('INVALID_ACROFORM_DATA_EXPORT_OPTIONS', 'A plain data export request with a supported profile and source digest is required.', 400); } }
function sourceCopy(value) {
  if (value === undefined) return DEFAULT_ACROFORM_DATA_EXPORT_SOURCE_COPY;
  if (!value || typeof value !== 'object' || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2 || !Reflect.ownKeys(value).every((key) => typeof key === 'string' && ['stage', 'assert'].includes(key))) throw new TypeError('sourceCopy must be an exact plain source-copy dependency.');
  const entries = Object.getOwnPropertyDescriptors(value); if (Object.values(entries).some((entry) => !Object.hasOwn(entry, 'value') || entry.enumerable !== true) || typeof entries.stage?.value !== 'function' || typeof entries.assert?.value !== 'function') throw new TypeError('sourceCopy must be an exact plain source-copy dependency.');
  return Object.freeze({ stage: entries.stage.value, assert: entries.assert.value });
}
function translated(error, deadline, signal) {
  if (deadline.timedOut) return host('ACROFORM_DATA_EXPORT_TIMEOUT', 'AcroForm data export exceeded its deadline.', 504, error);
  if (signal?.aborted || error?.code === 'JOB_CANCELLED') return host('JOB_CANCELLED', 'AcroForm data export was cancelled.', 499, error);
  if (error?.code === 'SOURCE_VERSION_MISMATCH') return host('SOURCE_VERSION_MISMATCH', 'The data export source changed while it was being verified.', 409, error);
  if (error instanceof HostError) return error;
  return host('ACROFORM_DATA_EXPORT_FAILED', 'The local host could not export AcroForm data.', 502, error);
}

export class PdfAcroFormDataExportService {
  #store; #sourceCopy;
  constructor({ store, sourceCopy: injected } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfAcroFormDataExportService requires a DocumentStore-compatible store.'); this.#store = store; this.#sourceCopy = sourceCopy(injected); }
  async export(documentId, request, options = {}) {
    const signal = exactOptions(options); const frozen = snapshot(request);
    if (frozen.profile !== PDF_ACROFORM_DATA_EXPORT_PROFILE || !SHA256.test(frozen.sourceSha256)) throw host('INVALID_ACROFORM_DATA_EXPORT_OPTIONS', 'A supported profile and lowercase source digest are required.', 400);
    const source = this.#store.getDocument(documentId);
    if (source.sha256 !== frozen.sourceSha256) throw host('SOURCE_VERSION_MISMATCH', 'The data export source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDF_ACROFORM_DATA_EXPORT_SOURCE_BYTES) throw host('ACROFORM_DATA_EXPORT_INPUT_TOO_LARGE', 'The data export source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACROFORM_DATA_EXPORT_JOB_MS); const lifecycle = { workspace: null, completed: false }; let operationError; let output;
    try { output = await runAcroFormDataExportJob({ store: this.#store, documentId, source, request: frozen, deadline, lifecycle, sourceCopy: this.#sourceCopy }); }
    catch (error) { operationError = error; }
    finally { deadline.dispose(); }
    try { await cleanupAcroFormDataExportJob({ store: this.#store, lifecycle }); }
    catch (cleanupError) {
      if (operationError) throw host('ACROFORM_DATA_EXPORT_CLEANUP_FAILED', 'AcroForm data export cleanup failed after an operation failure.', 500, new AggregateError([operationError, cleanupError], 'AcroForm data export operation and cleanup failed.'));
      throw cleanupError;
    }
    if (operationError) throw translated(operationError, deadline, signal);
    return output;
  }
}
export const AcroFormDataExportService = PdfAcroFormDataExportService;
