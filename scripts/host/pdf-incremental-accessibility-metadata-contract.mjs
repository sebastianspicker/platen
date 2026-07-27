import { types } from 'node:util';

const FIELDS = Object.freeze(['language', 'title']);
const INVALID_TEXT = /[\p{Cc}\p{Cf}]/u;

function invalid(message = 'Incremental PDF accessibility metadata must contain language and title.') {
  const error = new Error(message);
  error.code = 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA';
  return error;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function language(value) {
  if (typeof value !== 'string' || value.length > 35
    || !/^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/u.test(value)) {
    throw invalid('Incremental PDF accessibility language is invalid.');
  }
  return value.toLowerCase();
}

function title(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || hasUnpairedSurrogate(value) || value.normalize('NFC') !== value
    || value.trim() !== value || INVALID_TEXT.test(value)) {
    throw invalid('Incremental PDF accessibility title is invalid.');
  }
  return value;
}

export const INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE = 'local-incremental-document-language-title-v1';

export function normalizeIncrementalAccessibilityMetadata(value) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Array.isArray(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || FIELDS.some((name) => !Object.hasOwn(descriptors, name)
    || !Object.hasOwn(descriptors[name], 'value'))
    || keys.some((name) => typeof name !== 'string' || !FIELDS.includes(name))) throw invalid();
  return Object.freeze({ language: language(descriptors.language.value), title: title(descriptors.title.value) });
}
