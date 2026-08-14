import { HostError } from '../host-error.mjs';
import { normalizeOcrDocumentRequest } from '../../../src/core/ocr-contract.js';
import { OUTPUT_INTENT_PROFILE } from '../prepress/output-intent-contract.mjs';
import { FULL_PAGE_REDACTION_PROFILE } from '../../../src/core/pdf-full-page-redaction-contract.js';

export const AUTOMATION_INSPECT_TYPE = 'automation_inspect_v1';
export const AUTOMATION_OCR_TYPE = 'automation_ocr_v1';
export const AUTOMATION_OUTPUT_INTENT_TYPE = 'automation_output_intent_v1';
export const AUTOMATION_FULL_PAGE_REDACTION_TYPE = 'automation_full_page_redaction_v1';
export const SHA256 = /^[a-f0-9]{64}$/u;
export const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
export const MAX_FULL_PAGE_REDACTION_PAGES = 100;
export const MAX_FULL_PAGE_REDACTION_PAGE = 100;
export const AUTOMATION_PRESET_SCHEMA_VERSION = 1;
export const AUTOMATION_INSPECT_PRESET = 'inspect-local-v1';
export const AUTOMATION_OCR_PRESET = 'ocr-english-document-v1';
export const AUTOMATION_OUTPUT_INTENT_PRESET = 'output-intent-cmyk-v1';
const OCR_LANGUAGE = /^[a-z][a-z0-9_]{0,31}$/u;
const PRESET_FIELDS = new Set(['preset', 'sha256', 'sourceId']);

const PRESET_DESCRIPTORS = new Map([
  [AUTOMATION_INSPECT_PRESET, Object.freeze({
    version: AUTOMATION_PRESET_SCHEMA_VERSION,
    id: AUTOMATION_INSPECT_PRESET,
    type: AUTOMATION_INSPECT_TYPE,
    fields: Object.freeze({}),
  })],
  [AUTOMATION_OCR_PRESET, Object.freeze({
    version: AUTOMATION_PRESET_SCHEMA_VERSION,
    id: AUTOMATION_OCR_PRESET,
    type: AUTOMATION_OCR_TYPE,
    fields: Object.freeze({
      language: 'eng', cleanupPreset: 'document', segmentation: 'auto',
      userDictionary: Object.freeze([]),
    }),
  })],
  [AUTOMATION_OUTPUT_INTENT_PRESET, Object.freeze({
    version: AUTOMATION_PRESET_SCHEMA_VERSION,
    id: AUTOMATION_OUTPUT_INTENT_PRESET,
    type: AUTOMATION_OUTPUT_INTENT_TYPE,
    fields: Object.freeze({ profile: OUTPUT_INTENT_PROFILE }),
  })],
]);
export const AUTOMATION_PRESET_IDS = Object.freeze([...PRESET_DESCRIPTORS.keys()].sort());

export function invalidOperation(message) {
  throw new HostError('INVALID_AUTOMATION_OPERATION', message, 400);
}

function plainPayload(value) {
  if (!value) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasPayloadHeader(payload, expected) {
  if (!plainPayload(payload)) return false;
  return Object.keys(payload).sort().join(',') === expected;
}

function hasEnumerableDataDescriptor(descriptors, key) {
  if (!Object.hasOwn(descriptors, key)) return false;
  const descriptor = descriptors[key];
  if (!Object.hasOwn(descriptor, 'value')) return false;
  return descriptor.enumerable === true;
}

function fullPageNumber(page) {
  return Number.isSafeInteger(page) && page >= 1 && page <= MAX_FULL_PAGE_REDACTION_PAGE;
}

function presetData(payload) {
  try {
    if (!plainPayload(payload)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(payload);
    const keys = Reflect.ownKeys(payload);
    if (keys.length !== 3) return null;
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      if (!hasEnumerableDataDescriptor(descriptors, key)) return null;
      if (!PRESET_FIELDS.has(key)) return null;
    }
    return Object.freeze({
      preset: descriptors.preset.value,
      sha256: descriptors.sha256.value,
      sourceId: descriptors.sourceId.value,
    });
  } catch {
    return null;
  }
}

export function automationPresetDescriptor(id) {
  const descriptor = PRESET_DESCRIPTORS.get(id);
  if (!descriptor) invalidOperation('Automation preset is not allowlisted.');
  return descriptor;
}

export function presetPayload(payload) {
  const data = presetData(payload);
  if (!data) invalidOperation('Automation preset payload is invalid.');
  if (typeof data.preset !== 'string') invalidOperation('Automation preset payload is invalid.');
  if (!OPAQUE_ID.test(data.sourceId)) invalidOperation('Automation preset payload is invalid.');
  if (!SHA256.test(data.sha256)) invalidOperation('Automation preset payload is invalid.');
  automationPresetDescriptor(data.preset);
  return data;
}

export function expandAutomationPreset(payload) {
  const data = presetPayload(payload);
  const descriptor = automationPresetDescriptor(data.preset);
  return Object.freeze({
    sourceId: data.sourceId,
    sha256: data.sha256,
    ...descriptor.fields,
  });
}

export function sourcePayload(payload) {
  if (!hasPayloadHeader(payload, 'sha256,sourceId')) invalidOperation('Automation operation payload is invalid.');
  if (!OPAQUE_ID.test(payload.sourceId)) invalidOperation('Automation operation payload is invalid.');
  if (!SHA256.test(payload.sha256)) invalidOperation('Automation operation payload is invalid.');
  return Object.freeze({ sourceId: payload.sourceId, sha256: payload.sha256 });
}

export function normalizedOcrOptions(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) {
    invalidOperation('Automation OCR options are invalid.');
  }
  const language = options.language ?? 'eng';
  const installed = typeof language === 'string' ? language.split('+') : [];
  try {
    // PdfOcrService performs the environment-specific installed-language check.
    return normalizeOcrDocumentRequest({
      language,
      cleanupPreset: options.cleanupPreset,
      segmentation: options.segmentation,
      userDictionary: options.userDictionary,
    }, installed);
  } catch (error) {
    invalidOperation(error?.message ?? 'Automation OCR options are invalid.');
  }
}

export function ocrPayload(payload) {
  if (!hasPayloadHeader(payload, 'cleanupPreset,language,segmentation,sha256,sourceId,userDictionary')) invalidOperation('Automation OCR operation payload is invalid.');
  if (!OPAQUE_ID.test(payload.sourceId)) invalidOperation('Automation OCR operation payload is invalid.');
  if (!SHA256.test(payload.sha256)) invalidOperation('Automation OCR operation payload is invalid.');
  if (typeof payload.language !== 'string') invalidOperation('Automation OCR operation payload is invalid.');
  if (!payload.language.split('+').every((token) => OCR_LANGUAGE.test(token))) invalidOperation('Automation OCR operation payload is invalid.');
  const options = normalizedOcrOptions(payload);
  return Object.freeze({
    sourceId: payload.sourceId, sha256: payload.sha256,
    language: options.language, cleanupPreset: options.cleanupPreset,
    segmentation: options.segmentation, userDictionary: options.userDictionary,
  });
}

export function outputIntentPayload(payload) {
  if (!hasPayloadHeader(payload, 'profile,sha256,sourceId')) invalidOperation('Automation OutputIntent operation payload is invalid.');
  if (payload.profile !== OUTPUT_INTENT_PROFILE) invalidOperation('Automation OutputIntent operation payload is invalid.');
  if (!OPAQUE_ID.test(payload.sourceId)) invalidOperation('Automation OutputIntent operation payload is invalid.');
  if (!SHA256.test(payload.sha256)) invalidOperation('Automation OutputIntent operation payload is invalid.');
  return Object.freeze({
    sourceId: payload.sourceId, sha256: payload.sha256, profile: OUTPUT_INTENT_PROFILE,
  });
}

function normalizedFullPageRedactionPages(payload) {
  if (!Array.isArray(payload.pages)) invalidOperation('Automation full-page redaction operation payload is invalid.');
  if (payload.pages.length < 1) invalidOperation('Automation full-page redaction operation payload is invalid.');
  if (payload.pages.length > MAX_FULL_PAGE_REDACTION_PAGES) invalidOperation('Automation full-page redaction operation payload is invalid.');
  const normalizedPages = [];
  let previousPage = 0;
  for (const page of payload.pages) {
    if (!fullPageNumber(page)) invalidOperation('Automation full-page redaction operation payload is invalid.');
    if (page <= previousPage) invalidOperation('Automation full-page redaction pages must be unique and ascending.');
    previousPage = page;
    normalizedPages.push(page);
  }
  if (!normalizedPages.length) invalidOperation('Automation full-page redaction operation payload is invalid.');
  return normalizedPages;
}

export function fullPageRedactionPayload(payload) {
  if (!hasPayloadHeader(payload, 'pages,sha256,sourceId')) invalidOperation('Automation operation payload is invalid.');
  if (!OPAQUE_ID.test(payload.sourceId)) invalidOperation('Automation operation payload is invalid.');
  if (!SHA256.test(payload.sha256)) invalidOperation('Automation operation payload is invalid.');
  const normalizedPages = normalizedFullPageRedactionPages(payload);
  return Object.freeze({
    sourceId: payload.sourceId, sha256: payload.sha256, pages: Object.freeze(normalizedPages),
    profile: FULL_PAGE_REDACTION_PROFILE,
  });
}
