const UNSAFE_OUTLINE_LABEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u;

export function validPdfKitOutlineLabel(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || value !== value.normalize('NFC') || UNSAFE_OUTLINE_LABEL.test(value)) return false;
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes >= 1 && bytes <= 1_024;
}
