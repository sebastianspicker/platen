import { isProxy } from 'node:util/types';

export const PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE = 'local-pdf-form-javascript-inventory-v1';
export const PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS = Object.freeze({
  maxSourceBytes: 16 * 1024 * 1024,
  maxObjects: 2_048,
  maxNodes: 20_000,
  maxFields: 64,
  maxActions: 64,
  maxScriptBytes: 64 * 1024,
  maxTotalScriptBytes: 256 * 1024,
});

function failure(message = 'The form JavaScript inventory request is invalid.') { const error = new Error(message); error.code = 'INVALID_PDF_FORM_JAVASCRIPT_INVENTORY'; return error; }
export function normalizePdfFormJavaScriptInventoryRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys.some((key) => typeof key !== 'string' || !['profile', 'sourceSha256'].includes(key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
    || descriptors.profile?.value !== PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE
    || typeof descriptors.sourceSha256?.value !== 'string' || !/^[0-9a-f]{64}$/u.test(descriptors.sourceSha256.value)) throw failure();
  return Object.freeze({ profile: PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE, sourceSha256: descriptors.sourceSha256.value });
}
