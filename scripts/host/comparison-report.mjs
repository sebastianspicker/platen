import { isProxy } from 'node:util/types';
import { spreadsheetSafeCsvCell } from '../../src/core/spreadsheet-safe-csv.js';
import { HostError } from './host-error.mjs';

export const MAX_COMPARISON_REPORT_BYTES = 16 * 1024 * 1024;

const SHA256 = /^[a-f0-9]{64}$/u;
const DOCUMENT_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const MAX_PAGES = 200;
const MAX_RUNS_PER_PAGE = 40_000;
const MAX_TOKENS_PER_PAGE = 20_000;
const MAX_SNAPSHOT_ITEMS = 200_000;
const MAX_SNAPSHOT_DEPTH = 12;
const issuedContentReports = new WeakSet();

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function rejectInheritedJsonHooks() {
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) {
    fail('INVALID_REPORT', 'Comparison report export rejects inherited JSON hooks.', 502);
  }
}

function recordSnapshotNode(state, depth) {
  state.items += 1;
  if (state.items > MAX_SNAPSHOT_ITEMS || depth > MAX_SNAPSHOT_DEPTH) {
    fail('COMPARISON_REPORT_LIMIT', 'Comparison report exceeds its structural limit.', 413);
  }
}

function snapshotPrimitive(value, state) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_REPORT', 'Comparison reports require finite numbers.', 502);
    return value;
  }
  if (typeof value === 'string') {
    state.stringBytes += Buffer.byteLength(value);
    if (state.stringBytes > MAX_COMPARISON_REPORT_BYTES) {
      fail('COMPARISON_REPORT_LIMIT', 'Comparison report exceeds its text limit.', 413);
    }
    return value;
  }
  return undefined;
}

function invalidSnapshotObject(value, state) {
  return !value || typeof value !== 'object' || isProxy(value) || state.active.has(value);
}

function isDataDescriptor(descriptor) {
  return 'value' in descriptor && descriptor.enumerable === true;
}

function invalidSnapshotArray(value) {
  return Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_SNAPSHOT_ITEMS;
}

function invalidArrayData(descriptors, keys, length) {
  const expected = Array.from({ length }, (_, index) => String(index));
  const actual = keys.filter((key) => key !== 'length');
  if (actual.length !== expected.length || actual.some((key) => typeof key !== 'string')) return true;
  return expected.some((key) => !Object.hasOwn(descriptors, key)
    || !isDataDescriptor(descriptors[key]));
}

function snapshotArray(value, snapshot) {
  const { descriptors, keys, state, depth } = snapshot;
  if (invalidSnapshotArray(value)) {
    fail('INVALID_REPORT', 'Comparison reports contain an invalid array.', 502);
  }
  if (invalidArrayData(descriptors, keys, value.length)) {
    fail('INVALID_REPORT', 'Comparison report arrays must be dense data only.', 502);
  }
  return Array.from({ length: value.length }, (_, index) => snapshotData(
    descriptors[index].value, state, depth + 1,
  ));
}

function snapshotPlainObject(value, snapshot) {
  const { descriptors, keys, state, depth } = snapshot;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('INVALID_REPORT', 'Comparison reports contain a non-plain object.', 502);
  }
  if (keys.some((key) => typeof key !== 'string' || !isDataDescriptor(descriptors[key]))) {
    fail('INVALID_REPORT', 'Comparison report objects must contain data properties only.', 502);
  }
  const result = Object.create(null);
  for (const key of keys) {
    result[key] = snapshotData(descriptors[key].value, state, depth + 1);
  }
  return result;
}

function snapshotData(value, state = {
  active: new Set(), items: 0, stringBytes: 0,
}, depth = 0) {
  recordSnapshotNode(state, depth);
  const primitive = snapshotPrimitive(value, state);
  if (primitive !== undefined) return primitive;
  if (invalidSnapshotObject(value, state)) {
    fail('INVALID_REPORT', 'Comparison reports require acyclic plain data.', 502);
  }
  state.active.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const snapshot = { descriptors, keys, state, depth };
  const result = Array.isArray(value)
    ? snapshotArray(value, snapshot)
    : snapshotPlainObject(value, snapshot);
  state.active.delete(value);
  return result;
}

function count(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail('INVALID_REPORT', `${label} must be a bounded non-negative integer.`, 502);
  }
  return value;
}

function sourceBindingHasValidHash(input) {
  return typeof input.sha256 === 'string' && SHA256.test(input.sha256);
}

function sourceBindingHasValidDocumentId(input) {
  return typeof input.documentId === 'string' && DOCUMENT_ID.test(input.documentId);
}

function validSourceBinding(input, role, includeDocumentIds) {
  if (!input || typeof input !== 'object' || input.role !== role) return false;
  if (!sourceBindingHasValidHash(input)) return false;
  return !includeDocumentIds || sourceBindingHasValidDocumentId(input);
}

function stableInputs(inputs, includeDocumentIds) {
  if (!Array.isArray(inputs) || inputs.length !== 2) {
    fail('INVALID_REPORT', 'Comparison reports require exactly two source bindings.', 502);
  }
  return Object.freeze(inputs.map((input, index) => {
    const role = index === 0 ? 'primary' : 'secondary';
    if (!validSourceBinding(input, role, includeDocumentIds)) {
      fail('INVALID_REPORT', 'Comparison source bindings are invalid or out of order.', 502);
    }
    return Object.freeze({
      ...(includeDocumentIds ? { documentId: input.documentId } : {}),
      sha256: input.sha256,
      role,
    });
  }));
}

function validRun(run) {
  return run && typeof run === 'object'
    && ['added', 'deleted', 'unchanged'].includes(run.kind)
    && typeof run.text === 'string';
}

function stableRun(run) {
  if (!validRun(run)) {
    fail('INVALID_REPORT', 'Content comparison token runs are invalid.', 502);
  }
  const runCount = count(run.count, MAX_TOKENS_PER_PAGE, 'Comparison run count');
  if (runCount < 1) fail('INVALID_REPORT', 'Comparison token runs cannot be empty.', 502);
  return Object.freeze({ kind: run.kind, text: run.text, count: runCount });
}

function pageHasExpectedNumber(page, index) {
  return page.page === index + 1;
}

function pageHasPresenceFlags(page) {
  return typeof page.leftPresent === 'boolean' && typeof page.rightPresent === 'boolean';
}

function pageHasBoundedRuns(page) {
  return Array.isArray(page.runs) && page.runs.length <= MAX_RUNS_PER_PAGE;
}

function pageHasStats(page) {
  return Boolean(page.stats) && typeof page.stats === 'object';
}

function validPageShape(page, index) {
  if (!page || typeof page !== 'object') return false;
  if (!pageHasExpectedNumber(page, index)) return false;
  if (!pageHasPresenceFlags(page)) return false;
  if (!pageHasBoundedRuns(page)) return false;
  return pageHasStats(page);
}

function stableCounts(values, definitions) {
  const stable = {};
  for (const [key, maximum, label] of definitions) {
    stable[key] = count(values[key], maximum, label);
  }
  return Object.freeze(stable);
}

function stablePageStats(stats) {
  return stableCounts(stats, [
    ['added', MAX_TOKENS_PER_PAGE, 'Page added count'],
    ['deleted', MAX_TOKENS_PER_PAGE, 'Page deleted count'],
    ['unchanged', MAX_TOKENS_PER_PAGE, 'Page unchanged count'],
  ]);
}

function pageRunCount(runs, kind) {
  return runs.filter((run) => run.kind === kind)
    .reduce((total, run) => total + run.count, 0);
}

function verifyPageRunCounts(runs, stats) {
  for (const kind of ['added', 'deleted', 'unchanged']) {
    if (pageRunCount(runs, kind) !== stats[kind]) {
      fail('INVALID_REPORT', 'Content comparison page counts do not match its token runs.', 502);
    }
  }
}

function stablePage(page, index) {
  if (!validPageShape(page, index)) {
    fail('INVALID_REPORT', 'Content comparison pages are invalid or out of order.', 502);
  }
  const runs = Object.freeze(page.runs.map(stableRun));
  const stats = stablePageStats(page.stats);
  verifyPageRunCounts(runs, stats);
  return Object.freeze({
    page: page.page,
    leftPresent: page.leftPresent,
    rightPresent: page.rightPresent,
    runs,
    stats,
  });
}

function validContentReportShape(report) {
  if (report?.kind !== 'content' || !Array.isArray(report.pages)) return false;
  if (report.pages.length < 1 || report.pages.length > MAX_PAGES) return false;
  return Boolean(report.stats) && typeof report.stats === 'object';
}

function stableAggregateStats(stats) {
  return stableCounts(stats, [
    ['added', MAX_PAGES * MAX_TOKENS_PER_PAGE, 'Aggregate added count'],
    ['deleted', MAX_PAGES * MAX_TOKENS_PER_PAGE, 'Aggregate deleted count'],
    ['unchanged', MAX_PAGES * MAX_TOKENS_PER_PAGE, 'Aggregate unchanged count'],
    ['changed', 2 * MAX_PAGES * MAX_TOKENS_PER_PAGE, 'Aggregate changed count'],
    ['leftPages', MAX_PAGES, 'Primary page count'],
    ['rightPages', MAX_PAGES, 'Secondary page count'],
  ]);
}

function aggregatePageCount(pages, key) {
  return pages.reduce((total, page) => total + page.stats[key], 0);
}

function verifyAggregateCounts(pages, stats) {
  for (const key of ['added', 'deleted', 'unchanged']) {
    if (aggregatePageCount(pages, key) !== stats[key]) {
      fail('INVALID_REPORT', 'Content comparison aggregate counts are inconsistent.', 502);
    }
  }
}

function matchingPresentPageCount(pages, side) {
  return pages.filter((page) => page[side]).length;
}

function verifyAggregateMetadata(pages, stats) {
  if (stats.changed !== stats.added + stats.deleted
    || stats.leftPages !== matchingPresentPageCount(pages, 'leftPresent')
    || stats.rightPages !== matchingPresentPageCount(pages, 'rightPresent')) {
    fail('INVALID_REPORT', 'Content comparison aggregate metadata is inconsistent.', 502);
  }
}

function stableContentReport(report, { includeDocumentIds = false } = {}) {
  if (!validContentReportShape(report)) {
    fail('INVALID_REPORT', 'A bounded content comparison report is required.', 502);
  }
  const pages = Object.freeze(report.pages.map(stablePage));
  const stats = stableAggregateStats(report.stats);
  verifyAggregateCounts(pages, stats);
  verifyAggregateMetadata(pages, stats);
  return Object.freeze({
    kind: 'content',
    inputs: stableInputs(report.inputs, includeDocumentIds),
    stats,
    pages,
  });
}

function boundedData(data) {
  if (Buffer.byteLength(data) > MAX_COMPARISON_REPORT_BYTES) {
    fail('COMPARISON_REPORT_LIMIT', 'Comparison report exceeds the local export limit.', 413);
  }
  return data;
}

function jsonData(report) {
  const stable = stableContentReport(report);
  return boundedData(`${JSON.stringify(stable, null, 2)}\n`);
}

function csvData(report) {
  const stable = stableContentReport(report);
  const [primary, secondary] = stable.inputs;
  const rows = [[
    'primarySha256', 'secondarySha256', 'kind', 'page', 'status',
    'added', 'deleted', 'unchanged', 'changedPixels', 'comparedPixels',
  ], ...stable.pages.map((page) => [
    primary.sha256, secondary.sha256, stable.kind, page.page, '',
    page.stats.added, page.stats.deleted, page.stats.unchanged, '', '',
  ])];
  return boundedData(
    `${rows.map((row) => row.map(spreadsheetSafeCsvCell).join(',')).join('\n')}\n`,
  );
}

export function issueContentComparisonReport(report) {
  rejectInheritedJsonHooks();
  const issued = stableContentReport(snapshotData(report), { includeDocumentIds: true });
  issuedContentReports.add(issued);
  return issued;
}

/** Validate a privacy-minimal content receipt without granting host-issued status. */
export function validateContentComparisonReceipt(report) {
  rejectInheritedJsonHooks();
  return stableContentReport(snapshotData(report));
}

export function exportContentComparisonReport(report, { format = 'json' } = {}) {
  if (!report || typeof report !== 'object' || !issuedContentReports.has(report)) {
    fail('INVALID_REPORT', 'Comparison export requires an exact host-issued content report.', 502);
  }
  rejectInheritedJsonHooks();
  if (format === 'json') {
    return Object.freeze({
      mediaType: 'application/json', extension: 'json', data: jsonData(report),
    });
  }
  if (format !== 'csv') {
    fail('UNSUPPORTED_EXPORT_FORMAT', 'Content comparison reports can be exported as JSON or CSV.');
  }
  return Object.freeze({
    mediaType: 'text/csv', extension: 'csv', data: csvData(report),
  });
}
