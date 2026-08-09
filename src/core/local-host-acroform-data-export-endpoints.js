import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_ACROFORM_DATA_EXPORT_PROFILE = 'local-acroform-data-export-v1';
export const PDF_ACROFORM_DATA_EXPORT_KIND = 'pdf-acroform-data-export';
const SHA256 = /^[0-9a-f]{64}$/u;
const LIMITATIONS = Object.freeze(['Exports one existing terminal text field from an eligible passive classic AcroForm PDF as UTF-8 CSV.', 'Formula-leading cells after leading whitespace are excluded; no import, FDF, XFDF, XML, mutation, artifact, network, calculations, actions, XFA, or signatures are supported.']);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function plain(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false; return Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => Object.hasOwn(entry, 'value') && entry.enumerable); }
function exact(value, keys) { return plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function dense(value, expected) { if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== expected.length || Reflect.ownKeys(value).length !== value.length + 1) return false; const descriptors = Object.getOwnPropertyDescriptors(value); return Object.hasOwn(descriptors.length, 'value') && descriptors.length.enumerable === false && Array.from({ length: expected.length }, (_, index) => descriptors[index]).every((item, index) => item && Object.hasOwn(item, 'value') && item.enumerable === true && typeof item.value === 'string' && item.value === expected[index]); }
function wellFormed(value) { for (let index = 0; index < value.length; index += 1) { const unit = value.charCodeAt(index); if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; index += 1; } else if (unit >= 0xdc00 && unit <= 0xdfff) return false; } return true; }
function cell(value, maximum = 2_000) { return typeof value === 'string' && value.length <= maximum && value === value.normalize('NFC') && wellFormed(value) && !/[\u0000-\u001f\u007f-\u009f\ufffd\p{Cf}]/u.test(value) && !/^\s*[=+\-@]/u.test(value); }
function parseCsv(value) {
  if (typeof value !== 'string') throw new TypeError('The local host returned invalid AcroForm CSV.');
  const bytes = Buffer.from(value, 'utf8'); if (bytes.length > 8_192 || !bytes.subarray(0, 3).equals(BOM)) throw new TypeError('The local host returned invalid AcroForm CSV.');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3)); } catch { throw new TypeError('The local host returned invalid AcroForm CSV.'); }
  const match = /^fieldName,currentValue\r\n"((?:[^"]|"")*)","((?:[^"]|"")*)"\r\n$/us.exec(text); if (!match) throw new TypeError('The local host returned invalid AcroForm CSV.');
  const fieldName = match[1].replaceAll('""', '"'); const currentValue = match[2].replaceAll('""', '"');
  const canonical = Buffer.from(`\ufefffieldName,currentValue\r\n"${fieldName.replaceAll('"', '""')}","${currentValue.replaceAll('"', '""')}"\r\n`, 'utf8');
  if (!cell(fieldName, 127) || !cell(currentValue) || !canonical.equals(bytes)) throw new TypeError('The local host returned noncanonical AcroForm CSV.');
  return { bytes, fieldName, currentValue };
}
function snapshot(request) { if (!exact(request, ['profile', 'sourceSha256']) || request.profile !== PDF_ACROFORM_DATA_EXPORT_PROFILE || !SHA256.test(request.sourceSha256 ?? '')) throw new TypeError('AcroForm data export request is invalid.'); return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256 }); }
function signal(options) { if (!plain(options) || !exact(options, Object.hasOwn(options, 'signal') ? ['signal'] : []) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('AcroForm data export options are invalid.'); return options.signal; }
export function validateAcroFormDataExportResult(result, { documentId, sourceSha256 }) {
  if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '') || !exact(result, ['kind', 'sourceSha256', 'csv', 'csvSha256', 'fieldNameSha256', 'valueSha256', 'fieldCount', 'limitations', 'localOnly']) || result.kind !== PDF_ACROFORM_DATA_EXPORT_KIND || result.sourceSha256 !== sourceSha256 || !SHA256.test(result.csvSha256 ?? '') || !SHA256.test(result.fieldNameSha256 ?? '') || !SHA256.test(result.valueSha256 ?? '') || result.fieldCount !== 1 || !dense(result.limitations, LIMITATIONS) || result.localOnly !== true) throw new TypeError('The local host returned an invalid AcroForm data export result.');
  const csv = parseCsv(result.csv); if (digest(csv.bytes) !== result.csvSha256 || digest(Buffer.from(csv.fieldName, 'utf8')) !== result.fieldNameSha256 || digest(Buffer.from(csv.currentValue, 'utf8')) !== result.valueSha256) throw new TypeError('The local host returned an invalid AcroForm data export result.');
  return Object.freeze(structuredClone(result));
}
export function createAcroFormDataExportEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('AcroForm data export endpoints require JSON transport.');
  return Object.freeze({ exportAcroFormData(documentId, request, options = {}) { if (!OPAQUE_ID_PATTERN.test(documentId ?? '')) throw new TypeError('AcroForm data export document id is invalid.'); const fixed = snapshot(request); return postJson(json, documentEndpointPath(documentId, '/acroform-data-export'), fixed, signal(options)).then((body) => validateAcroFormDataExportResult(body?.result, { documentId, sourceSha256: fixed.sourceSha256 })); } });
}
