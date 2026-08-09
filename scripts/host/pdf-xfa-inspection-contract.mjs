import { isProxy } from 'node:util/types';

export const PDF_XFA_INSPECTION_PROFILE = 'local-pdf-xfa-presence-inspection-v1';
export const PDF_XFA_INSPECTION_LIMITS = Object.freeze({
  maxSourceBytes: 16 * 1024 * 1024,
  maxObjects: 2_048,
});

function failure() {
  const error = new Error('The XFA inspection request is invalid.');
  error.code = 'INVALID_PDF_XFA_INSPECTION';
  return error;
}

export function normalizePdfXfaInspectionRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys.some((key) => typeof key !== 'string' || !['profile', 'sourceSha256'].includes(key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
    || descriptors.profile?.value !== PDF_XFA_INSPECTION_PROFILE
    || typeof descriptors.sourceSha256?.value !== 'string' || !/^[0-9a-f]{64}$/u.test(descriptors.sourceSha256.value)) throw failure();
  return Object.freeze({ profile: PDF_XFA_INSPECTION_PROFILE, sourceSha256: descriptors.sourceSha256.value });
}
