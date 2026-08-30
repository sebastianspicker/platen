export const ACCESSIBILITY_ALT_TEXT_MAX_UTF16 = 1000;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const FORMAT = /\p{Cf}/u;
const PATH_LIKE_PREFIX = /^(?:\/|~\/|\.\.?[\\/]|[A-Za-z]:[\\/]|\\\\)/u;

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Returns canonical human-authored alt text, or null for unsafe/invalid input. */
export function normalizeAccessibilityAltText(value) {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value)) return null;
  const normalized = value.trim().normalize('NFC');
  if (!normalized.length || normalized.length > ACCESSIBILITY_ALT_TEXT_MAX_UTF16
    || CONTROL.test(normalized) || FORMAT.test(normalized)
    || PATH_LIKE_PREFIX.test(normalized)) return null;
  return normalized;
}

export function validAccessibilityAltText(value) {
  return normalizeAccessibilityAltText(value) !== null;
}
