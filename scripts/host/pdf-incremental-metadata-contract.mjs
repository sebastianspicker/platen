const FIELD_NAMES = Object.freeze(['title', 'author', 'subject', 'keywords']);
const INVALID_TEXT = /[\p{Cc}\p{Cf}]/u;

function invalid(message = 'Incremental PDF metadata must contain exactly four bounded fields.') {
  const error = new Error(message);
  error.code = 'INVALID_INCREMENTAL_METADATA';
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

function field(value, name) {
  if (value === null) return null;
  if (typeof value !== 'string' || hasUnpairedSurrogate(value)
    || value.normalize('NFC') !== value || value.trim() !== value || INVALID_TEXT.test(value)
    || Buffer.byteLength(value, 'utf8') > 1_024) {
    throw invalid(`Incremental PDF metadata ${name} is invalid.`);
  }
  return value;
}

export const INCREMENTAL_METADATA_FIELDS = FIELD_NAMES;
export const INCREMENTAL_METADATA_PROFILE = 'local-classic-incremental-metadata-v1';

export function normalizeIncrementalMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELD_NAMES.length
    || FIELD_NAMES.some((name) => !Object.hasOwn(descriptors, name)
      || !Object.hasOwn(descriptors[name], 'value'))
    || keys.some((name) => typeof name !== 'string' || !FIELD_NAMES.includes(name))) throw invalid();
  return Object.freeze(Object.fromEntries(FIELD_NAMES.map(
    (name) => [name, field(descriptors[name].value, name)],
  )));
}
