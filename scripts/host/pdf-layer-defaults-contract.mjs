export const PDF_LAYER_DEFAULTS_PROFILE = 'local-layer-defaults-v1';
export const LAYER_DEFAULTS_PROFILE = PDF_LAYER_DEFAULTS_PROFILE;

function invalid(message = 'PDF layer-defaults request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_PDF_LAYER_DEFAULTS';
  return error;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  return descriptors;
}

export function normalizePdfLayerDefaults(value) {
  const request = exactObject(value, ['profile', 'sourceSha256', 'changes']);
  if (request.profile.value !== PDF_LAYER_DEFAULTS_PROFILE
    || typeof request.sourceSha256.value !== 'string'
    || !/^[0-9a-f]{64}$/u.test(request.sourceSha256.value)) throw invalid();
  const changes = request.changes.value;
  if (!Array.isArray(changes) || Object.getPrototypeOf(changes) !== Array.prototype) throw invalid();
  const arrayDescriptors = Object.getOwnPropertyDescriptors(changes);
  if (!Number.isSafeInteger(arrayDescriptors.length?.value)
    || arrayDescriptors.length.value > 100
    || Object.keys(arrayDescriptors).length !== arrayDescriptors.length.value + 1) throw invalid();
  let previous = -1;
  const normalized = [];
  for (let index = 0; index < arrayDescriptors.length.value; index += 1) {
    if (!Object.hasOwn(arrayDescriptors, index) || arrayDescriptors[index].enumerable !== true) throw invalid();
    const change = exactObject(arrayDescriptors[index].value, ['groupIndex', 'visible']);
    const groupIndex = change.groupIndex.value;
    if (!Number.isSafeInteger(groupIndex) || groupIndex < 0 || groupIndex <= previous
      || typeof change.visible.value !== 'boolean') throw invalid();
    previous = groupIndex;
    normalized.push(Object.freeze({ groupIndex, visible: change.visible.value }));
  }
  return Object.freeze({
    profile: PDF_LAYER_DEFAULTS_PROFILE,
    sourceSha256: request.sourceSha256.value,
    changes: Object.freeze(normalized),
  });
}

export const normalizeIncrementalPdfLayerDefaults = normalizePdfLayerDefaults;
