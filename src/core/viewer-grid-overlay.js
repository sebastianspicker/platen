import { isProxy } from 'node:util/types';
import { isViewerAnalysisBound } from './viewer-analysis-binding.js';

const INPUT_KEYS = Object.freeze(['requested', 'document', 'analysis']);

function invalidInput(label) {
  throw new TypeError(`${label} must be an exact plain data object.`);
}

function plainDataObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalidInput(label);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) invalidInput(label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      invalidInput(label);
    }
  }
  return value;
}

function exactInput(value) {
  plainDataObject(value, 'input');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== INPUT_KEYS.length || INPUT_KEYS.some((key) => !Object.hasOwn(value, key))) {
    invalidInput('input');
  }
  return value;
}

function validateDocument(value) {
  const document = plainDataObject(value, 'document');
  const descriptors = Object.getOwnPropertyDescriptors(document);
  if (!Object.hasOwn(descriptors, 'isOpen') || typeof descriptors.isOpen.value !== 'boolean'
    || !Object.hasOwn(descriptors, 'objectUrl')) {
    invalidInput('document');
  }
  if (document.isOpen
    && (typeof descriptors.objectUrl.value !== 'string'
      || !descriptors.objectUrl.value.startsWith('blob:')
      || descriptors.objectUrl.value.length <= 'blob:'.length)) {
    invalidInput('document');
  }
  return document;
}

export function isViewerDocumentBound(value) {
  try {
    const document = validateDocument(value);
    return document.isOpen === true
      && typeof document.objectUrl === 'string'
      && document.objectUrl.startsWith('blob:')
      && document.objectUrl.length > 'blob:'.length;
  } catch {
    return false;
  }
}

export function deriveViewerGridVisibility(value) {
  const input = exactInput(value);
  const requested = input.requested;
  if (typeof requested !== 'boolean') invalidInput('requested');
  const document = validateDocument(input.document);
  const analysis = input.analysis;
  if (analysis !== null && analysis !== undefined) plainDataObject(analysis, 'analysis');
  return requested && isViewerDocumentBound(document) && isViewerAnalysisBound(analysis) === true;
}
