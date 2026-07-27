export const INCREMENTAL_NAMED_DESTINATION_PROFILE = 'local-incremental-named-destination-v1';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function invalid() {
  const error = new Error('Incremental named-destination request is invalid.');
  error.code = 'INVALID_INCREMENTAL_NAMED_DESTINATION';
  return error;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
      || !keys.includes(key))) throw invalid();
  return descriptors;
}

export function normalizeIncrementalNamedDestination(value) {
  const request = exactObject(value, ['profile', 'targetPage', 'name']);
  if (request.profile.value !== INCREMENTAL_NAMED_DESTINATION_PROFILE
    || !Number.isSafeInteger(request.targetPage.value)
    || request.targetPage.value < 1 || request.targetPage.value > 100
    || typeof request.name.value !== 'string' || !NAME.test(request.name.value)) {
    throw invalid();
  }
  return Object.freeze({
    profile: INCREMENTAL_NAMED_DESTINATION_PROFILE,
    targetPage: request.targetPage.value,
    name: request.name.value,
  });
}
