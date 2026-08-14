import { normalizeClassicPdfObjectValue } from './pdf-classic-object-value.mjs';

const MAX_APPEND_BYTES = 1024 * 1024;

function invalid() {
  const error = new Error('The incremental PDF object value is invalid.');
  error.code = 'INVALID_CLASSIC_INCREMENTAL_OBJECT_VALUE';
  return error;
}

function limitExceeded() {
  const error = new Error('The incremental PDF object value exceeds its fixed limit.');
  error.code = 'CLASSIC_INCREMENTAL_LIMIT_EXCEEDED';
  return error;
}

function streamDictionary(value, length) {
  if (value?.type !== 'dict' || Object.getPrototypeOf(value.entries) !== Map.prototype) throw invalid();
  const entries = new Map(value.entries);
  entries.set('Length', Object.freeze({
    type: 'number', value: length, integer: true, raw: String(length),
  }));
  return Object.freeze({ type: 'dict', entries });
}

export function serializedIncrementalObjectValue(value, streamBytes) {
  try {
    if (streamBytes !== undefined && (!Buffer.isBuffer(streamBytes)
      || streamBytes.length > MAX_APPEND_BYTES)) {
      if (Buffer.isBuffer(streamBytes)) throw limitExceeded();
      throw invalid();
    }
    const bytes = streamBytes === undefined ? null : Buffer.from(streamBytes);
    const normalized = normalizeClassicPdfObjectValue(
      bytes === null ? value : streamDictionary(value, bytes.length),
    );
    const type = normalized.value?.type === 'dict'
      ? normalized.value.entries.get('Type') : null;
    if (type?.type === 'name' && ['XRef', 'ObjStm'].includes(type.value)) throw invalid();
    return Object.freeze({ ...normalized, streamBytes: bytes });
  } catch (error) {
    if (error?.code === 'CLASSIC_INCREMENTAL_LIMIT_EXCEEDED') throw error;
    if (error?.code === 'CLASSIC_PDF_OBJECT_VALUE_LIMIT_EXCEEDED') throw limitExceeded();
    if (error?.code === 'INVALID_CLASSIC_INCREMENTAL_OBJECT_VALUE') throw error;
    throw invalid();
  }
}
