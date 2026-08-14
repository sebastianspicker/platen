import { isProxy } from 'node:util/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MIN_PAGE = 1;
const MAX_PAGE = 10_000;

const INVALID = 'invalid';
const STATUS = 'status';
const IDENTITY = 'identity';
const PAGE_COUNT = 'page-count';
const TEXT_PAGES = 'text-pages';

function dataObject(value, { allowExtra = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== Object.keys(descriptors).length) return false;
  if (!allowExtra && ownKeys.length !== 2) return false;
  return ownKeys.every((key) => typeof key === 'string'
    && Object.hasOwn(descriptors, key)
    && Object.hasOwn(descriptors[key], 'value')
    && descriptors[key].enumerable === true);
}

function exactTextPage(value) {
  if (!dataObject(value, { allowExtra: false })) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2 && keys.includes('page') && keys.includes('text')
    && Number.isSafeInteger(value.page) && value.page >= MIN_PAGE && value.page <= MAX_PAGE
    && typeof value.text === 'string';
}

function exactTextPages(value, pageCount) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
      || !exactTextPage(value[index]) || value[index].page > pageCount) return false;
  }
  return new Set(value.map(({ page }) => page)).size === value.length;
}

function result(reason, values = {}) {
  return Object.freeze({
    ready: false,
    reason,
    documentId: values.documentId ?? null,
    sourceSha256: values.sourceSha256 ?? null,
    pageCount: values.pageCount ?? null,
  });
}

export function inspectViewerAnalysisBinding(analysis) {
  if (!dataObject(analysis)) return result(INVALID);
  if (analysis.status !== 'ready') return result(STATUS);
  if (typeof analysis.documentId !== 'string' || !UUID.test(analysis.documentId)
    || typeof analysis.sha256 !== 'string' || !SHA256.test(analysis.sha256)) return result(IDENTITY);
  if (!dataObject(analysis.inspection)
    || !Number.isSafeInteger(analysis.inspection.pageCount)
    || analysis.inspection.pageCount < MIN_PAGE || analysis.inspection.pageCount > MAX_PAGE) return result(PAGE_COUNT);
  if (!exactTextPages(analysis.textPages, analysis.inspection.pageCount)) return result(TEXT_PAGES);
  return Object.freeze({
    ready: true,
    reason: null,
    documentId: analysis.documentId,
    sourceSha256: analysis.sha256,
    pageCount: analysis.inspection.pageCount,
  });
}

export function isViewerAnalysisBound(analysis) {
  return inspectViewerAnalysisBinding(analysis).ready;
}
