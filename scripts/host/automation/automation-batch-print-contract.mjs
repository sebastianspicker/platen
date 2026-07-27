import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import { AUTOMATION_INSPECT_TYPE } from './automation-operation-contract.mjs';
import { normalizeAutomationApiSubmitRequest } from './automation-api-contract.mjs';

export const AUTOMATION_BATCH_PRINT_SCHEMA_VERSION = 1;
export const AUTOMATION_BATCH_PRINT_MAX_DOCUMENTS = 8;
export const AUTOMATION_BATCH_PRINT_MAX_COPIES = 10;
export const AUTOMATION_BATCH_PRINT_MAX_PAGES = 100;
export const AUTOMATION_BATCH_PRINT_MAX_EXECUTIONS = 64;
export const AUTOMATION_BATCH_PRINT_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const AUTOMATION_BATCH_PRINT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function batchPrintFail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', `${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key)
    || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) {
    batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', `${label} contains unsupported fields, accessors, or symbols.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function dense(value, label, maximum) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length < 1 || value.length > maximum) batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', `${label} is outside its fixed bound.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)
    || Number(key) >= value.length || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) {
    batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', `${label} must be a dense data-only array.`);
  }
  return Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value);
}

function pages(value) {
  if (value === null) return null;
  let previous = 0;
  return Object.freeze(dense(value, 'batch print pages', AUTOMATION_BATCH_PRINT_MAX_PAGES).map((page) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > AUTOMATION_BATCH_PRINT_MAX_PAGES || page <= previous) batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', 'Batch print pages must be unique ascending bounded integers.');
    previous = page;
    return page;
  }));
}

function options(value) {
  const item = exact(value, ['collate', 'colorMode', 'duplex', 'media', 'scaling'], 'batch print options');
  if (typeof item.collate !== 'boolean' || !['auto', 'color', 'monochrome'].includes(item.colorMode)
    || !['one-sided', 'long-edge', 'short-edge'].includes(item.duplex)
    || !['auto', 'a4', 'letter'].includes(item.media) || !['actual', 'fit'].includes(item.scaling)) {
    batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', 'Batch print options are not allowlisted.');
  }
  return Object.freeze({ collate: item.collate, colorMode: item.colorMode, duplex: item.duplex, media: item.media, scaling: item.scaling });
}

export function normalizeAutomationBatchPrintRequest(value) {
  const item = exact(value, ['batchId', 'documents', 'grant', 'idempotencyKey', 'options', 'principal', 'printerId'], 'batch print request');
  if (typeof item.batchId !== 'string' || !ID.test(item.batchId) || typeof item.printerId !== 'string' || !ID.test(item.printerId)
    || typeof item.idempotencyKey !== 'string' || Buffer.byteLength(item.idempotencyKey, 'utf8') < 1
    || Buffer.byteLength(item.idempotencyKey, 'utf8') > 96 || /[\u0000-\u001f\u007f]/u.test(item.idempotencyKey)) {
    batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', 'Batch, printer, or idempotency identity is invalid.');
  }
  const ids = new Set();
  let authority = null;
  const documents = dense(item.documents, 'batch print documents', AUTOMATION_BATCH_PRINT_MAX_DOCUMENTS).map((raw) => {
    const document = exact(raw, ['copies', 'pages', 'source'], 'batch print document');
    if (!Number.isSafeInteger(document.copies) || document.copies < 1 || document.copies > AUTOMATION_BATCH_PRINT_MAX_COPIES) batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', 'Batch print copies are outside the fixed bound.');
    const base = normalizeAutomationApiSubmitRequest({
      principal: item.principal, grant: item.grant, source: document.source,
      operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null }, idempotencyKey: item.idempotencyKey,
    });
    authority ??= Object.freeze({ principal: base.principal, grant: base.grant });
    if (ids.has(base.source.id)) batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', 'Batch print source IDs must be unique.');
    ids.add(base.source.id);
    return Object.freeze({ source: base.source, copies: document.copies, pages: pages(document.pages) });
  });
  return Object.freeze({ schemaVersion: 1, batchId: item.batchId, printerId: item.printerId,
    principal: authority.principal, grant: authority.grant,
    idempotencyKey: item.idempotencyKey, documents: Object.freeze(documents), options: options(item.options) });
}

export function normalizeAutomationBatchPrintCancelRequest(value) {
  const item = exact(value, ['admissionId', 'grant', 'principal'], 'batch print cancel request');
  const base = normalizeAutomationApiSubmitRequest({ principal: item.principal, grant: item.grant,
    source: { id: 'batch_print_source', sha256: 'a'.repeat(64) }, operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null }, idempotencyKey: 'batch-print-cancel' });
  if (typeof item.admissionId !== 'string' || !/^bp_[a-f0-9]{32}$/u.test(item.admissionId)) batchPrintFail('INVALID_AUTOMATION_BATCH_PRINT', 'Batch print admission ID is invalid.');
  return Object.freeze({ principal: base.principal, grant: base.grant, admissionId: item.admissionId });
}
