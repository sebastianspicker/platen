export const OUTPUT_INTENT_PROFILE = 'local-ghostscript-default-cmyk-output-intent-v1';
export const OUTPUT_INTENT_LABEL = 'Ghostscript default CMYK (host-bundled)';

function invalid(message = 'PDF OutputIntent request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_OUTPUT_INTENT_REQUEST';
  return error;
}

/** Normalizes the deliberately closed request surface: callers select no file,
 * profile, label, or bytes.  The source digest is only a version binding. */
export function normalizeOutputIntentRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('profile') || !keys.includes('sourceSha256')
    || keys.some((key) => typeof key !== 'string'
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) {
    throw invalid();
  }
  const profile = descriptors.profile.value;
  const sourceSha256 = descriptors.sourceSha256.value;
  if (profile !== OUTPUT_INTENT_PROFILE
    || typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sourceSha256)) throw invalid();
  return Object.freeze({ profile: OUTPUT_INTENT_PROFILE, sourceSha256 });
}

export function outputIntentFailure(message) { return invalid(message); }
