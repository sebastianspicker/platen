import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

export const PDF_ACROFORM_DATA_EXPORT_PROFILE = 'local-acroform-data-export-v1';
export const PDF_ACROFORM_DATA_EXPORT_KIND = 'pdf-acroform-data-export';
export const PDF_ACROFORM_DATA_EXPORT_MAX_CSV_BYTES = 8_192;
export const PDF_ACROFORM_DATA_EXPORT_LIMITATIONS = Object.freeze([
  'Exports one existing terminal text field from an eligible passive classic AcroForm PDF as UTF-8 CSV.',
  'Formula-leading cells after leading whitespace are excluded; no import, FDF, XFDF, XML, mutation, artifact, network, calculations, actions, XFA, or signatures are supported.',
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const HEADER = 'fieldName,currentValue';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every((key) => typeof key === 'string') && Object.values(descriptors).every((item) => Object.hasOwn(item, 'value') && item.enumerable === true);
}
function exact(value, keys) { return plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function dense(value, expected) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== expected.length || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.hasOwn(descriptors.length, 'value') && descriptors.length.enumerable === false && Array.from({ length: expected.length }, (_, index) => descriptors[index]).every((item, index) => item && Object.hasOwn(item, 'value') && item.enumerable === true && typeof item.value === 'string' && item.value === expected[index]);
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function wellFormed(value) {
  for (let index = 0; index < value.length; index += 1) { const unit = value.charCodeAt(index); if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; index += 1; } else if (unit >= 0xdc00 && unit <= 0xdfff) return false; }
  return true;
}
export function isSafeAcroFormDataExportCell(value, maximum = 2_000) {
  return typeof value === 'string' && value.length <= maximum && value === value.normalize('NFC') && wellFormed(value)
    && !/[\u0000-\u001f\u007f-\u009f\ufffd\p{Cf}]/u.test(value) && !/^\s*[=+\-@]/u.test(value);
}
function cell(value) { return `"${value.replaceAll('"', '""')}"`; }

export function snapshotAcroFormDataExportRequest(request) {
  if (!exact(request, ['profile', 'sourceSha256']) || request.profile !== PDF_ACROFORM_DATA_EXPORT_PROFILE || !SHA256.test(request.sourceSha256 ?? '')) throw new TypeError('AcroForm data export request is invalid.');
  return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256 });
}
export function encodeAcroFormDataExportCsv(fieldName, currentValue) {
  if (!isSafeAcroFormDataExportCell(fieldName, 127) || !isSafeAcroFormDataExportCell(currentValue)) throw new TypeError('AcroForm data export CSV values are invalid.');
  const bytes = Buffer.from(`\ufeff${HEADER}\r\n${cell(fieldName)},${cell(currentValue)}\r\n`, 'utf8');
  if (bytes.length > PDF_ACROFORM_DATA_EXPORT_MAX_CSV_BYTES) throw new TypeError('AcroForm data export CSV exceeds its fixed bound.');
  return bytes;
}
export function parseAcroFormDataExportCsv(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < HEADER.length + 10 || bytes.length > PDF_ACROFORM_DATA_EXPORT_MAX_CSV_BYTES || !bytes.subarray(0, 3).equals(BOM)) throw new TypeError('AcroForm data export CSV is invalid.');
  let value; try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3)); } catch { throw new TypeError('AcroForm data export CSV is not UTF-8.'); }
  const match = /^fieldName,currentValue\r\n"((?:[^"]|"")*)","((?:[^"]|"")*)"\r\n$/us.exec(value);
  if (!match) throw new TypeError('AcroForm data export CSV must contain exactly one quoted row.');
  const fieldName = match[1].replaceAll('""', '"'); const currentValue = match[2].replaceAll('""', '"');
  if (!isSafeAcroFormDataExportCell(fieldName, 127) || !isSafeAcroFormDataExportCell(currentValue) || !encodeAcroFormDataExportCsv(fieldName, currentValue).equals(bytes)) throw new TypeError('AcroForm data export CSV is not canonical.');
  return Object.freeze({ fieldName, currentValue, csvSha256: digest(bytes) });
}
export function createAcroFormDataExportResult({ sourceSha256, fieldName, currentValue }) {
  if (!SHA256.test(sourceSha256 ?? '')) throw new TypeError('AcroForm data export source digest is invalid.');
  const bytes = encodeAcroFormDataExportCsv(fieldName, currentValue); const parsed = parseAcroFormDataExportCsv(bytes);
  if (parsed.fieldName !== fieldName || parsed.currentValue !== currentValue) throw new TypeError('AcroForm data export CSV reinspection failed.');
  return Object.freeze({ kind: PDF_ACROFORM_DATA_EXPORT_KIND, sourceSha256, csv: bytes.toString('utf8'), csvSha256: parsed.csvSha256, fieldNameSha256: digest(Buffer.from(fieldName, 'utf8')), valueSha256: digest(Buffer.from(currentValue, 'utf8')), fieldCount: 1, limitations: PDF_ACROFORM_DATA_EXPORT_LIMITATIONS, localOnly: true });
}
export function validateAcroFormDataExportResult(result, { sourceSha256 } = {}) {
  if (!SHA256.test(sourceSha256 ?? '') || !exact(result, ['kind', 'sourceSha256', 'csv', 'csvSha256', 'fieldNameSha256', 'valueSha256', 'fieldCount', 'limitations', 'localOnly']) || result.kind !== PDF_ACROFORM_DATA_EXPORT_KIND || result.sourceSha256 !== sourceSha256 || typeof result.csv !== 'string' || !SHA256.test(result.csvSha256 ?? '') || !SHA256.test(result.fieldNameSha256 ?? '') || !SHA256.test(result.valueSha256 ?? '') || result.fieldCount !== 1 || !dense(result.limitations, PDF_ACROFORM_DATA_EXPORT_LIMITATIONS) || result.localOnly !== true) return false;
  let parsed; try { parsed = parseAcroFormDataExportCsv(Buffer.from(result.csv, 'utf8')); } catch { return false; }
  return parsed.csvSha256 === result.csvSha256 && digest(Buffer.from(parsed.fieldName, 'utf8')) === result.fieldNameSha256 && digest(Buffer.from(parsed.currentValue, 'utf8')) === result.valueSha256;
}
