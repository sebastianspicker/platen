import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { parsePdfkitEnvelope, responseError, isFingerprint, isInteger } from './adapters/pdfkit/response-common.mjs';
import { fail } from './pdfkit-mutation-operation-errors.mjs';

export const PDFKIT_TEXT_FIELD_WIDGET_OPERATION = 'addTextFieldWidget';
export const PDFKIT_TEXT_FIELD_WIDGET_PROFILE = 'macos-pdfkit-acroform-text-field-widget-v1';
export const DEFAULT_TEXT_FIELD_WIDGET_LIMITS = Object.freeze({
  maxPages: 100,
  maxAnnotationsPerPage: 50,
  maxWidgetsPerPage: 50,
  maxOutlineDepth: 8,
  maxOutlineItems: 200,
});
export const PDFKIT_TEXT_FIELD_WIDGET_MAX_REQUEST_BYTES = 8_192;

const DIGEST = /^[0-9a-f]{64}$/u;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const MAX_COORDINATE = 1_000_000;

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) {
    fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', `${label} must contain exactly the supported fields.`);
  }
  return value;
}

function utf8Text(value, label, maximumBytes, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)
    || /[\p{Cf}]/u.test(value) || value.normalize('NFC') !== value
    || value.trim() !== value || Buffer.byteLength(value, 'utf8') > maximumBytes
    || (!allowEmpty && value.length === 0)) {
    fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', `${label} is not canonical bounded text.`);
  }
  // JS strings can contain lone UTF-16 surrogates; Swift String cannot.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', `${label} contains an unpaired surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', `${label} contains an unpaired surrogate.`);
    }
  }
  return value;
}

function rectangle(value, label) {
  const input = exactObject(value, ['x', 'y', 'width', 'height'], label);
  const output = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])
      || Math.abs(input[key]) > MAX_COORDINATE) {
      fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', `${label}.${key} must be a bounded finite number.`);
    }
    output[key] = input[key];
  }
  if (output.width <= 0 || output.height <= 0) {
    fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', `${label} must have positive dimensions.`);
  }
  return Object.freeze(output);
}

function limits(configured = {}) {
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)
    || Object.keys(configured).some((key) => !Object.hasOwn(DEFAULT_TEXT_FIELD_WIDGET_LIMITS, key))) {
    throw new TypeError('Text-field widget limits are invalid.');
  }
  const result = { ...DEFAULT_TEXT_FIELD_WIDGET_LIMITS, ...configured };
  for (const [key, maximum] of Object.entries(DEFAULT_TEXT_FIELD_WIDGET_LIMITS)) {
    const minimum = key === 'maxPages' ? 1 : key === 'maxWidgetsPerPage' ? 1 : 0;
    if (!Number.isSafeInteger(result[key]) || result[key] < minimum || result[key] > maximum) {
      throw new TypeError('Text-field widget limits exceed fixed local bounds.');
    }
  }
  return Object.freeze(result);
}

function sourceDigest(value) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', 'sourceSha256 must be a lowercase SHA-256 digest.');
  }
  return value;
}

export function normalizeTextFieldWidgetRequest(input, { pageCount = DEFAULT_TEXT_FIELD_WIDGET_LIMITS.maxPages } = {}) {
  const value = exactObject(input, ['sourceSha256', 'page', 'rect', 'fieldName', 'defaultValue'], 'text-field widget request');
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > DEFAULT_TEXT_FIELD_WIDGET_LIMITS.maxPages) {
    throw new TypeError('pageCount is outside the fixed local bound.');
  }
  if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > pageCount) {
    fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', 'page is outside the document.');
  }
  const fieldName = utf8Text(value.fieldName, 'fieldName', 64);
  if (!FIELD_NAME.test(fieldName)) {
    fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', 'fieldName must start with ASCII text and use only ASCII field-name characters.');
  }
  const defaultValue = value.defaultValue === null
    ? null : utf8Text(value.defaultValue, 'defaultValue', 256, { allowEmpty: true });
  return Object.freeze({
    sourceSha256: sourceDigest(value.sourceSha256),
    page: value.page,
    rect: rectangle(value.rect, 'rect'),
    fieldName,
    defaultValue,
  });
}

function swiftDouble(value) {
  if (Object.is(value, -0)) return '-0.0';
  if (Number.isInteger(value)) return `${value}.0`;
  return String(value).replace(/e(\+?)0+(\d+)/u, 'e$1$2');
}

export function digestTextFieldWidgetRect(rect) {
  const value = `${swiftDouble(rect.x)}|${swiftDouble(rect.y)}|${swiftDouble(rect.width)}|${swiftDouble(rect.height)}`;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestTextFieldWidgetDefaultValue(value) {
  const data = Buffer.from(value === null ? [0] : [1, ...Buffer.from(value, 'utf8')]);
  return createHash('sha256').update(data).digest('hex');
}

export function buildTextFieldWidgetRequest(normalized, limitsConfig = DEFAULT_TEXT_FIELD_WIDGET_LIMITS) {
  const value = normalizeTextFieldWidgetRequest(normalized);
  const boundedLimits = limits(limitsConfig);
  const request = {
    version: 1,
    operation: PDFKIT_TEXT_FIELD_WIDGET_OPERATION,
    inputFilename: 'input.pdf',
    outputFilename: 'output.pdf',
    sourceSha256: value.sourceSha256,
    limits: boundedLimits,
    field: {
      page: value.page, rect: value.rect, name: value.fieldName,
      ...(value.defaultValue === null ? {} : { defaultValue: value.defaultValue }),
    },
  };
  return Object.freeze(request);
}

export function serializeTextFieldWidgetRequest(normalized, limitsConfig = DEFAULT_TEXT_FIELD_WIDGET_LIMITS) {
  const request = buildTextFieldWidgetRequest(normalized, limitsConfig);
  const value = JSON.stringify(request);
  if (Buffer.byteLength(value, 'utf8') > PDFKIT_TEXT_FIELD_WIDGET_MAX_REQUEST_BYTES) {
    fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', 'The text-field widget request exceeds its byte limit.', 413);
  }
  return value;
}

function exactReceipt(value) {
  const keys = [
    'schema', 'version', 'operation', 'category', 'sourceSha256', 'outputSha256',
    'fieldNameSha256', 'defaultValueSha256', 'rectSha256', 'page', 'pageCount',
    'appliedEdits', 'directAcroFormTopologyVerified', 'terminalTextWidgetVerified',
    'sourceSafetyVerified', 'preservationVerified', 'reopenVerified',
  ];
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parsePdfkitTextFieldWidgetResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!exactReceipt(result)
    || result.schema !== 'pdfkit-text-field-widget-receipt-v1' || result.version !== 1
    || result.operation !== PDFKIT_TEXT_FIELD_WIDGET_OPERATION || result.category !== 'acroform-text-field-widget'
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || result.sourceSha256 === result.outputSha256 || !isFingerprint(result.fieldNameSha256)
    || !isFingerprint(result.defaultValueSha256) || !isFingerprint(result.rectSha256)
    || !isInteger(result.page, 1, DEFAULT_TEXT_FIELD_WIDGET_LIMITS.maxPages)
    || !isInteger(result.pageCount, 1, DEFAULT_TEXT_FIELD_WIDGET_LIMITS.maxPages)
    || result.page > result.pageCount || result.appliedEdits !== 1
    || result.directAcroFormTopologyVerified !== true || result.terminalTextWidgetVerified !== true
    || result.sourceSafetyVerified !== true || result.preservationVerified !== true
    || result.reopenVerified !== true) throw responseError();
  return Object.freeze({ ...result });
}

export function receiptMatchesTextFieldWidgetContract(receipt, normalized) {
  const value = normalizeTextFieldWidgetRequest(normalized, { pageCount: receipt?.pageCount ?? 1 });
  return exactReceipt(receipt)
    && receipt.sourceSha256 === value.sourceSha256
    && receipt.page === value.page
    && receipt.fieldNameSha256 === createHash('sha256').update(value.fieldName, 'utf8').digest('hex')
    && receipt.defaultValueSha256 === digestTextFieldWidgetDefaultValue(value.defaultValue)
    && receipt.rectSha256 === digestTextFieldWidgetRect(value.rect);
}

export function isSafePrivatePath(value) {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0');
}

