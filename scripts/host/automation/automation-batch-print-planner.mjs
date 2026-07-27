import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import { batchPrintFail } from './automation-batch-print-contract.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const PRINTER_ID = /^[A-Za-z0-9_-]{1,64}$/u;

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) batchPrintFail('AUTOMATION_BATCH_PRINT_PRINTER_INVALID', `${label} is invalid.`, 502);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) batchPrintFail('AUTOMATION_BATCH_PRINT_PRINTER_INVALID', `${label} contains unsupported fields or accessors.`, 502);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function stringList(value, allowed, label) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length < 1 || value.length > allowed.size) batchPrintFail('AUTOMATION_BATCH_PRINT_PRINTER_INVALID', `${label} is invalid.`, 502);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)
    || Number(key) >= value.length || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) batchPrintFail('AUTOMATION_BATCH_PRINT_PRINTER_INVALID', `${label} must be data-only.`, 502);
  const result = Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value);
  if (new Set(result).size !== result.length || result.some((item) => !allowed.has(item))) batchPrintFail('AUTOMATION_BATCH_PRINT_PRINTER_INVALID', `${label} contains unsupported values.`, 502);
  return Object.freeze(result);
}

export function normalizeTrustedPrinter(value, expectedId) {
  const item = exact(value, ['capabilities', 'id', 'identityDigest', 'status'], 'trusted printer');
  if (item.id !== expectedId || typeof item.id !== 'string' || !PRINTER_ID.test(item.id)
    || typeof item.identityDigest !== 'string' || !SHA256.test(item.identityDigest)
    || !['ready', 'offline'].includes(item.status)) batchPrintFail('AUTOMATION_BATCH_PRINT_PRINTER_INVALID', 'Trusted printer identity is invalid.', 502);
  const capabilities = exact(item.capabilities, ['colorModes', 'duplexModes', 'media', 'scaling'], 'trusted printer capabilities');
  return Object.freeze({ id: item.id, identityDigest: item.identityDigest, status: item.status,
    capabilities: Object.freeze({
      colorModes: stringList(capabilities.colorModes, new Set(['color', 'monochrome']), 'printer color modes'),
      duplexModes: stringList(capabilities.duplexModes, new Set(['one-sided', 'long-edge', 'short-edge']), 'printer duplex modes'),
      media: stringList(capabilities.media, new Set(['a4', 'letter']), 'printer media'),
      scaling: stringList(capabilities.scaling, new Set(['actual', 'fit']), 'printer scaling'),
    }) });
}

function supported(printer, options) {
  const color = options.colorMode === 'auto' || printer.capabilities.colorModes.includes(options.colorMode);
  const media = options.media === 'auto' || printer.capabilities.media.includes(options.media);
  return color && media && printer.capabilities.duplexModes.includes(options.duplex)
    && printer.capabilities.scaling.includes(options.scaling);
}

export function createAutomationBatchPrintPlan(request, printerValue) {
  const printer = normalizeTrustedPrinter(printerValue, request.printerId);
  if (printer.status !== 'ready') batchPrintFail('AUTOMATION_BATCH_PRINT_PRINTER_UNAVAILABLE', 'Trusted local printer is unavailable.', 503);
  if (!supported(printer, request.options)) batchPrintFail('AUTOMATION_BATCH_PRINT_OPTION_UNSUPPORTED', 'Trusted printer does not support the requested options.', 422);
  const documents = Object.freeze(request.documents.map((document, index) => Object.freeze({
    position: index + 1, source: Object.freeze({ ...document.source }), copies: document.copies,
    pages: document.pages === null ? null : Object.freeze([...document.pages]),
  })));
  const digestInput = { schemaVersion: 1, batchId: request.batchId, printer: { id: printer.id, identityDigest: printer.identityDigest }, documents, options: request.options };
  return Object.freeze({ schemaVersion: 1, batchId: request.batchId,
    printer: Object.freeze({ id: printer.id, identityDigest: printer.identityDigest }), documents,
    options: request.options, planDigest: createHash('sha256').update(JSON.stringify(digestInput), 'utf8').digest('hex') });
}

export class UnavailableLocalPrinterInventory {
  async resolve() { throw new HostError('AUTOMATION_BATCH_PRINT_PRINTER_UNAVAILABLE', 'No authorized local printer inventory is configured.', 503); }
}

export class UnavailableLocalPrintAdapter {
  async admit() { throw new HostError('AUTOMATION_BATCH_PRINT_UNAVAILABLE', 'No authorized local print adapter is configured.', 503); }
  async cancel() {}
}

