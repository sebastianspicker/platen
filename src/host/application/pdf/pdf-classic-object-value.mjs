import {
  pdfReference,
  serializePdfValue,
} from './pdf-classic-syntax.mjs';

const MAX_VALUE_DEPTH = 16;
const MAX_VALUE_ITEMS = 20_000;
const MAX_NAME_BYTES = 256;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_SERIALIZED_BYTES = 1024 * 1024;
const NUMERIC_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)$/u;

function invalid() {
  const error = new Error('The classic PDF object value is invalid.');
  error.code = 'INVALID_CLASSIC_PDF_OBJECT_VALUE';
  return error;
}

function limitExceeded() {
  const error = new Error('The classic PDF object value exceeds its fixed safety limits.');
  error.code = 'CLASSIC_PDF_OBJECT_VALUE_LIMIT_EXCEEDED';
  return error;
}

function dataValues(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const allowed = [...required, ...optional].sort();
  if (required.some((key) => !Object.hasOwn(descriptors, key))
    || keys.some((key) => !allowed.includes(key))
    || Object.values(descriptors).some((descriptor) => (
      !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
    ))) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function latin1(value, maximumBytes) {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'latin1') <= maximumBytes
    && Buffer.from(value, 'latin1').toString('latin1') === value;
}

function addDecodedBytes(state, count) {
  state.decodedBytes += count;
  if (state.decodedBytes > MAX_SERIALIZED_BYTES) throw limitExceeded();
}

function dataArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0) throw invalid();
  if (length > MAX_VALUE_ITEMS) throw limitExceeded();
  if (Object.keys(descriptors).length !== length + 1) throw invalid();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw invalid();
    }
    result.push(descriptor.value);
  }
  return result;
}

function snapshotScalar(value, fields, state) {
  if (fields.type === 'null') return Object.freeze({ type: 'null' });
  if (fields.type === 'boolean') {
    if (typeof fields.value !== 'boolean') throw invalid();
    return Object.freeze({ type: 'boolean', value: fields.value });
  }
  if (fields.type === 'number') {
    if (!Number.isFinite(fields.value)) throw invalid();
    const integer = Number.isSafeInteger(fields.value);
    if (fields.integer !== undefined && fields.integer !== integer) throw invalid();
    if (fields.raw !== undefined && (typeof fields.raw !== 'string'
      || !NUMERIC_TOKEN.test(fields.raw) || Number(fields.raw) !== fields.value)) throw invalid();
    return Object.freeze({
      type: 'number', value: fields.value, integer,
      ...(fields.raw === undefined ? {} : { raw: fields.raw }),
    });
  }
  if (fields.type === 'name') {
    if (!latin1(fields.value, MAX_NAME_BYTES)) throw invalid();
    addDecodedBytes(state, Buffer.byteLength(fields.value, 'latin1'));
    return Object.freeze({ type: 'name', value: fields.value });
  }
  if (fields.type === 'string') {
    if (!Buffer.isBuffer(fields.bytes) || fields.bytes.length > MAX_STRING_BYTES
      || (fields.format !== undefined && !['hex', 'literal'].includes(fields.format))) throw invalid();
    addDecodedBytes(state, fields.bytes.length);
    return Object.freeze({
      type: 'string', bytes: Buffer.from(fields.bytes),
      ...(fields.format === undefined ? {} : { format: fields.format }),
    });
  }
  if (fields.type === 'ref') {
    const reference = pdfReference(fields);
    const copy = Object.freeze({
      type: 'ref', object: reference.object, generation: reference.generation,
    });
    state.references.push(copy);
    return copy;
  }
  return null;
}

function snapshotValue(value, state, depth) {
  if (depth > MAX_VALUE_DEPTH) throw limitExceeded();
  const resolved = state.resolvePending?.(value);
  if (resolved !== undefined) return snapshotValue(resolved, state, depth);
  if (state.active.has(value)) throw invalid();
  if (state.memo.has(value)) return state.memo.get(value);
  const typeDescriptor = value && Object.getOwnPropertyDescriptor(value, 'type');
  if (!typeDescriptor || !Object.hasOwn(typeDescriptor, 'value')
    || typeof typeDescriptor.value !== 'string') throw invalid();
  const type = typeDescriptor.value;
  const shapes = {
    null: [['type'], []],
    boolean: [['type', 'value'], []],
    number: [['type', 'value'], ['integer', 'raw']],
    name: [['type', 'value'], []],
    string: [['type', 'bytes'], ['format']],
    ref: [['type', 'object', 'generation'], []],
    array: [['type', 'values'], []],
    dict: [['type', 'entries'], []],
  };
  const shape = shapes[type];
  if (!shape) throw invalid();
  const fields = dataValues(value, shape[0], shape[1]);
  state.uniqueItems += 1;
  if (state.uniqueItems > MAX_VALUE_ITEMS) throw limitExceeded();
  const scalar = snapshotScalar(value, fields, state);
  if (scalar) { state.memo.set(value, scalar); return scalar; }
  state.active.add(value);
  try {
    let result;
    if (type === 'array') {
      const values = dataArray(fields.values);
      result = Object.freeze({
        type: 'array',
        values: Object.freeze(values.map((entry) => (
          snapshotValue(entry, state, depth + 1)
        ))),
      });
    } else {
      if (Object.getPrototypeOf(fields.entries) !== Map.prototype) throw invalid();
      const entries = new Map();
      for (const [key, entry] of fields.entries) {
        if (!latin1(key, MAX_NAME_BYTES) || entries.has(key)) throw invalid();
        addDecodedBytes(state, Buffer.byteLength(key, 'latin1'));
        entries.set(key, snapshotValue(entry, state, depth + 1));
      }
      result = Object.freeze({ type: 'dict', entries });
    }
    state.memo.set(value, result);
    return result;
  } finally { state.active.delete(value); }
}

function addMeasuredBytes(state, count) {
  state.bytes += count;
  if (!Number.isSafeInteger(state.bytes) || state.bytes > MAX_SERIALIZED_BYTES) {
    throw limitExceeded();
  }
}

function measureExpanded(value, state, depth = 0) {
  state.items += 1;
  if (state.items > MAX_VALUE_ITEMS || depth > MAX_VALUE_DEPTH) throw limitExceeded();
  if (value.type === 'array') {
    addMeasuredBytes(state, 2 + Math.max(0, value.values.length - 1));
    for (const child of value.values) measureExpanded(child, state, depth + 1);
  } else if (value.type === 'dict') {
    addMeasuredBytes(state, 5);
    for (const [key, child] of value.entries) {
      addMeasuredBytes(state, 3 + (Buffer.byteLength(key, 'latin1') * 3));
      measureExpanded(child, state, depth + 1);
    }
  } else if (value.type === 'string') addMeasuredBytes(state, 2 + (value.bytes.length * 2));
  else if (value.type === 'name') {
    addMeasuredBytes(state, 1 + (Buffer.byteLength(value.value, 'latin1') * 3));
  } else addMeasuredBytes(state, Buffer.byteLength(serializePdfValue(value), 'latin1'));
}

export function snapshotClassicPdfObjectValue(value, { resolvePending } = {}) {
  if (resolvePending !== undefined && typeof resolvePending !== 'function') throw invalid();
  const state = {
    active: new Set(), memo: new Map(), uniqueItems: 0, decodedBytes: 0,
    references: [], resolvePending,
  };
  const snapshot = snapshotValue(value, state, 0);
  measureExpanded(snapshot, { items: 0, bytes: 0 });
  return Object.freeze({
    value: snapshot,
    references: Object.freeze(state.references),
  });
}

export function normalizeClassicPdfObjectValue(value, options = {}) {
  const normalized = snapshotClassicPdfObjectValue(value, options);
  const body = serializePdfValue(normalized.value);
  if (Buffer.byteLength(body, 'latin1') > MAX_SERIALIZED_BYTES) throw limitExceeded();
  return Object.freeze({ ...normalized, body });
}
