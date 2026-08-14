import { createDeadline } from './workspace-job-runtime.mjs';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { boundedNfcText, validateAcroFormValues } from './pdf-acroform-validation-core.mjs';
import { cleanupAcroFormValidationJob, MAX_PDF_ACROFORM_VALIDATION_JOB_MS, MAX_PDF_ACROFORM_VALIDATION_SOURCE_BYTES, runAcroFormValidationJob } from './pdf-acroform-validation-job.mjs';

export const PDF_ACROFORM_VALIDATION_PROFILE = 'local-acroform-validation-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob']);
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function copyPlain(value, keys, message) { try { if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) throw new Error(); const descriptors = Object.getOwnPropertyDescriptors(value); if ((keys && (Object.keys(descriptors).length !== keys.length || Object.keys(descriptors).some((key) => !keys.includes(key)))) || Object.values(descriptors).some((entry) => !Object.hasOwn(entry, 'value') || entry.enumerable !== true)) throw new Error(); return descriptors; } catch { throw host('INVALID_ACROFORM_VALIDATION_OPTIONS', message, 400); } }
function snapshot(request) {
  const requestFields = copyPlain(request, ['profile', 'sourceSha256', 'values', 'rules'], 'A plain validation request with data properties only is required.'); const valuesFields = copyPlain(requestFields.values.value, null, 'values must be a plain object.'); const rulesFields = copyPlain(requestFields.rules.value, null, 'rules must be a plain object.'); const names = Object.keys(valuesFields); if (names.length > 100 || Object.keys(rulesFields).some((name) => !Object.hasOwn(valuesFields, name))) throw host('INVALID_ACROFORM_VALIDATION_OPTIONS', 'Validation fields and rules are outside the bounded subset.', 400);
  const values = {}; const rules = {}; for (const name of names) { try { boundedNfcText(name, 'values field name'); } catch { throw host('INVALID_ACROFORM_VALIDATION_OPTIONS', 'Validation field names must be bounded NFC text.', 400); } values[name] = valuesFields[name].value; const rule = rulesFields[name]?.value ?? {}; const ruleFields = copyPlain(rule, null, 'Validation rules must be plain objects.'); if (Object.keys(ruleFields).some((key) => !['required', 'type', 'minLength', 'maxLength'].includes(key))) throw host('INVALID_ACROFORM_VALIDATION_OPTIONS', 'Regex and unsupported validation rules are not admitted.', 400); rules[name] = Object.fromEntries(Object.entries(ruleFields).map(([key, descriptor]) => [key, descriptor.value])); }
  try { validateAcroFormValues(values, rules); } catch { throw host('INVALID_ACROFORM_VALIDATION_OPTIONS', 'Validation values or rules are invalid.', 400); }
  return Object.freeze({ profile: requestFields.profile.value, sourceSha256: requestFields.sourceSha256.value, values: Object.freeze(values), rules: Object.freeze(rules) });
}
export class PdfAcroFormValidationService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfAcroFormValidationService requires a DocumentStore-compatible store.'); this.#store = store; }
  async validate(documentId, request, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const frozen = snapshot(request);
    if (frozen.profile !== PDF_ACROFORM_VALIDATION_PROFILE || !SHA256.test(String(frozen.sourceSha256 ?? ''))) throw host('INVALID_ACROFORM_VALIDATION_OPTIONS', 'A supported profile and lowercase source digest are required.', 400);
    const source = this.#store.getDocument(documentId);
    if (source.sha256 !== frozen.sourceSha256) throw host('SOURCE_VERSION_MISMATCH', 'The validation source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDF_ACROFORM_VALIDATION_SOURCE_BYTES) throw host('ACROFORM_VALIDATION_INPUT_TOO_LARGE', 'The validation source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACROFORM_VALIDATION_JOB_MS);
    const lifecycle = { workspace: null, completed: false };
    try { return await runAcroFormValidationJob({ store: this.#store, documentId, source, request: frozen, deadline, lifecycle }); }
    catch (error) {
      if (deadline.timedOut) throw host('ACROFORM_VALIDATION_TIMEOUT', 'AcroForm validation exceeded its deadline.', 504, error);
      if (signal?.aborted || error?.code === 'JOB_CANCELLED') throw host('JOB_CANCELLED', 'AcroForm validation was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      throw host('ACROFORM_VALIDATION_FAILED', 'The local host could not validate the AcroForm values.', 502, error);
    } finally { deadline.dispose(); await cleanupAcroFormValidationJob({ store: this.#store, lifecycle }); }
  }
}
export const AcroFormValidationService = PdfAcroFormValidationService;
