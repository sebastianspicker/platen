export const PDFKIT_MUTATION_PROFILE = 'macos-pdfkit-derived-v1';
export const PDFKIT_TARGETED_PROFILE = 'macos-pdfkit-targeted-v1';
export const PDFKIT_LOCAL_GOTO_PROFILE = 'macos-pdfkit-local-goto-v1';
export const PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE = 'macos-pdfkit-local-goto-remove-v1';
export const PDFKIT_OUTLINE_PROFILE = 'macos-pdfkit-outline-v1';
export const PDFKIT_OUTLINE_REMOVAL_PROFILE = 'macos-pdfkit-outline-remove-v1';
export const PDFKIT_OUTLINE_RENAME_PROFILE = 'macos-pdfkit-outline-rename-v1';
export const PDFKIT_LINE_ANNOTATION_PROFILE = 'macos-pdfkit-line-annotation-v1';
export const PDFKIT_INK_ANNOTATION_PROFILE = 'macos-pdfkit-ink-annotation-v1';
export const PDFKIT_PROTECTION_PROFILE = 'macos-pdfkit-aes128-v1';
export const PDFKIT_PROTECTION_REMOVAL_PROFILE = 'macos-pdfkit-remove-protection-v1';
export const PDFKIT_METADATA_SANITIZATION_PROFILE = 'macos-pdfkit-metadata-sanitize-v1';
export const OPAQUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function exactObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

export function validPdfKitRectangle(value) {
  return exactObject(value, ['x', 'y', 'width', 'height'])
    && Object.values(value).every((coordinate) => typeof coordinate === 'number'
      && Number.isFinite(coordinate) && Math.abs(coordinate) <= 1_000_000)
    && value.width > 0 && value.height > 0;
}

export function validPdfKitPoint(value) {
  return exactObject(value, ['x', 'y'])
    && Object.values(value).every((coordinate) => typeof coordinate === 'number'
      && Number.isFinite(coordinate) && Math.abs(coordinate) <= 1_000_000);
}

export function validPdfKitLocator(value, extraKeys = []) {
  return exactObject(value, ['page', 'annotationIndex', 'fingerprint', ...extraKeys])
    && Number.isSafeInteger(value.page) && value.page >= 1 && value.page <= 100
    && Number.isSafeInteger(value.annotationIndex) && value.annotationIndex >= 0
    && value.annotationIndex < 50
    && /^[0-9a-f]{64}$/.test(value.fingerprint);
}

export function validPdfKitOutlineLocator(value) {
  return exactObject(value, ['topLevelIndex', 'fingerprint'])
    && Number.isSafeInteger(value.topLevelIndex)
    && value.topLevelIndex >= 0 && value.topLevelIndex < 200
    && /^[0-9a-f]{64}$/.test(value.fingerprint);
}
