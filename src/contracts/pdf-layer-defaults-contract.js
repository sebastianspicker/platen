export const PDF_LAYER_DEFAULTS_PROFILE = 'local-layer-defaults-v1';
const MAX_CHANGES = 100;

export function validPdfLayerDefaultsChanges(value) {
  if (!Array.isArray(value) || value.length > MAX_CHANGES) return false;
  let previous = -1;
  for (const change of value) {
    if (!change || typeof change !== 'object' || Array.isArray(change)
      || Object.getPrototypeOf(change) !== Object.prototype
      || !Number.isSafeInteger(change.groupIndex) || change.groupIndex < 0
      || typeof change.visible !== 'boolean' || change.groupIndex <= previous) return false;
    previous = change.groupIndex;
  }
  return true;
}

export function normalizePdfLayerDefaults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || value.profile !== PDF_LAYER_DEFAULTS_PROFILE
    || typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceSha256)
    || !validPdfLayerDefaultsChanges(value.changes)) {
    throw new TypeError('PDF layer-defaults request is invalid.');
  }
  return Object.freeze({
    profile: PDF_LAYER_DEFAULTS_PROFILE,
    sourceSha256: value.sourceSha256,
    changes: Object.freeze(value.changes.map(({ groupIndex, visible }) => Object.freeze({ groupIndex, visible }))),
  });
}
