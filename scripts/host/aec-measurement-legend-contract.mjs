import { createHash } from 'node:crypto';
import { validateAecMeasurementResult } from '../../src/core/aec-contract.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_RECORDS = 500;
const MAX_SUM = 1_000_000_000_000;
const CANCELLED = 'JOB_CANCELLED';
const DISPLAY_UNITS = new Set(['mm', 'cm', 'm', 'in', 'ft', 'mm2', 'cm2', 'm2', 'in2', 'ft2', 'count']);
const LENGTH_DISPLAY_UNITS = new Set(['mm', 'cm', 'm', 'in', 'ft']);
const AREA_DISPLAY_UNITS = new Set(['mm2', 'cm2', 'm2', 'in2', 'ft2']);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'AEC_LEGEND_CONTRACT_INVALID';
  throw error;
}

function exactPlain(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label} must be a plain object.`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid(`${label} contains unsupported fields.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || descriptor.get || descriptor.set) invalid(`${label}.${key} must be a data property.`);
  }
  return value;
}

function exactArray(value, label, minimum = 0, maximum = MAX_RECORDS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum) invalid(`${label} has an unsupported length.`);
  const own = Reflect.ownKeys(value);
  if (own.length !== value.length + 1 || own.some((key) => key !== 'length' && !/^\d+$/u.test(key))) invalid(`${label} contains unsupported fields.`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || descriptor.get || descriptor.set) invalid(`${label}[${index}] must be a data property.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || lengthDescriptor.enumerable || lengthDescriptor.get || lengthDescriptor.set) invalid(`${label}.length must be a data property.`);
  return value;
}

function snapshot(value, label = 'value', seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) invalid(`${label} must not contain cycles.`);
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    exactArray(value, label, 0, MAX_RECORDS);
    output = value.map((entry, index) => snapshot(entry, `${label}[${index}]`, seen));
  } else {
    const keys = Reflect.ownKeys(value);
    if (Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label} must be JSON-shaped.`);
    if (keys.some((key) => typeof key !== 'string')) invalid(`${label} contains a symbol key.`);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || descriptor.get || descriptor.set) invalid(`${label}.${key} must be an enumerable data property.`);
    }
    output = {};
    for (const key of keys) output[key] = snapshot(value[key], `${label}.${key}`, seen);
  }
  seen.delete(value);
  return output;
}

function digest(value, label) { if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${label} must be a lowercase SHA-256 digest.`); return value; }
function identifier(value, label) { if (typeof value !== 'string' || !ID.test(value)) invalid(`${label} must be a bounded identifier.`); return value; }
function integer(value, label, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} is outside the supported range.`); return value; }
function text(value, label) { if (typeof value !== 'string' || value.length < 1 || value.length > 160 || !value.trim()) invalid(`${label} must be bounded non-empty text.`); return value; }
function labelDigest(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function throwIfAborted(signal) { if (signal?.aborted) { const error = new Error('AEC measurement legend generation was cancelled.'); error.code = CANCELLED; error.status = 499; throw error; } }

function measurementRecord(value, sourceSha256, record) {
  const validated = validateAecMeasurementResult(value);
  if (validated.sourceDigest !== sourceSha256 || validated.workspaceRevision !== record.revision
    || validated.measurement.source.sha256 !== sourceSha256 || validated.measurement.source.page !== record.page) {
    invalid('Measurement record is not bound to the requested source, sheet revision, or page.');
  }
  const measurement = validated.measurement; const expectedDimension = measurement.kind === 'area' ? 'area' : measurement.kind === 'count' ? 'count' : 'length'; const expectedSiUnit = measurement.kind === 'area' ? 'm2' : measurement.kind === 'count' ? 'count' : 'm'; const validDisplayUnit = measurement.kind === 'area' ? AREA_DISPLAY_UNITS.has(measurement.result.displayUnit) : measurement.kind === 'count' ? measurement.result.displayUnit === 'count' : LENGTH_DISPLAY_UNITS.has(measurement.result.displayUnit);
  if (measurement.result.dimension !== expectedDimension || measurement.result.siUnit !== expectedSiUnit || !validDisplayUnit || (measurement.kind === 'count' && (measurement.calibrationId !== null || !Number.isSafeInteger(measurement.result.siValue)))) invalid('Measurement record has inconsistent kind, calibration, or units.');
  return validated;
}

export function normalizeAecMeasurementLegendRequest(value) {
  const input = snapshot(value, 'AEC measurement legend request');
  exactPlain(input, ['sourceSha256', 'expectedRevision', 'records'], 'AEC measurement legend request');
  const sourceSha256 = digest(input.sourceSha256, 'sourceSha256');
  const expectedRevision = integer(input.expectedRevision, 'expectedRevision', 1, 1_000_000);
  exactArray(input.records, 'records', 1, MAX_RECORDS);
  const records = input.records.map((entry, index) => {
    exactPlain(entry, ['sheetId', 'page', 'revision', 'toolId', 'styleId', 'measurement'], `records[${index}]`);
    const record = {
      sheetId: identifier(entry.sheetId, `records[${index}].sheetId`),
      page: integer(entry.page, `records[${index}].page`, 1, 100_000),
      revision: integer(entry.revision, `records[${index}].revision`, 1, 1_000_000),
      toolId: identifier(entry.toolId, `records[${index}].toolId`),
      styleId: identifier(entry.styleId, `records[${index}].styleId`),
      measurement: entry.measurement,
    };
    if (record.revision !== expectedRevision) invalid(`records[${index}] is not from expected sheet revision.`);
    record.measurement = measurementRecord(record.measurement, sourceSha256, record);
    return Object.freeze(record);
  });
  const ids = new Set(); const provenance = new Set();
  for (const record of records) {
    const measurement = record.measurement.measurement;
    if (ids.has(measurement.id) || provenance.has(measurement.provenanceSha256)) invalid('Legend records must not contain duplicate measurement IDs or provenance digests.');
    ids.add(measurement.id); provenance.add(measurement.provenanceSha256);
  }
  return deepFreeze({ sourceSha256, expectedRevision, records });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createAecMeasurementLegend(value, { signal } = {}) {
  const input = normalizeAecMeasurementLegendRequest(value);
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const sorted = [...input.records].sort((left, right) => {
    const a = left.measurement.measurement; const b = right.measurement.measurement;
    return compare(`${left.toolId}\u0000${left.styleId}\u0000${a.id}`, `${right.toolId}\u0000${right.styleId}\u0000${b.id}`);
  });
  const groups = new Map();
  for (const record of sorted) {
    throwIfAborted(signal);
    const measurement = record.measurement.measurement;
    const key = `${record.toolId}\u0000${record.styleId}\u0000${measurement.kind}\u0000${measurement.calibrationId ?? 'uncalibrated'}\u0000${measurement.result.dimension}\u0000${measurement.result.siUnit}\u0000${measurement.result.displayUnit}`;
    let group = groups.get(key);
    if (!group) {
      group = { toolId: record.toolId, styleId: record.styleId, kind: measurement.kind, dimension: measurement.result.dimension, siUnit: measurement.result.siUnit, displayUnit: measurement.result.displayUnit, calibrationId: measurement.calibrationId, count: 0, totalSiValue: 0, measurements: [], provenance: [] };
      groups.set(key, group);
    }
    group.count += 1;
    group.totalSiValue += measurement.result.siValue;
    if (!Number.isFinite(group.totalSiValue) || group.totalSiValue > MAX_SUM) invalid('Legend aggregate exceeds the supported finite range.');
    group.measurements.push({ id: measurement.id, page: record.page, sheetId: record.sheetId, kind: measurement.kind, dimension: measurement.result.dimension, calibrationId: measurement.calibrationId, displayUnit: measurement.result.displayUnit, labelDigest: labelDigest(measurement.label), siValue: measurement.result.siValue, siUnit: measurement.result.siUnit });
    group.provenance.push({ id: measurement.id, provenanceSha256: measurement.provenanceSha256, sourceSha256: input.sourceSha256, page: record.page, revision: record.revision });
  }
  const result = { kind: 'aec-measurement-legend', schemaVersion: 1, sourceDigest: input.sourceSha256, sheetRevision: input.expectedRevision, groups: [...groups.values()].sort((left, right) => compare(`${left.toolId}\u0000${left.styleId}\u0000${left.kind}\u0000${left.calibrationId ?? 'uncalibrated'}\u0000${left.dimension}\u0000${left.siUnit}\u0000${left.displayUnit}`, `${right.toolId}\u0000${right.styleId}\u0000${right.kind}\u0000${right.calibrationId ?? 'uncalibrated'}\u0000${right.dimension}\u0000${right.siUnit}\u0000${right.displayUnit}`)), recordCount: input.records.length };
  return deepFreeze(result);
}

export function validateAecMeasurementLegendResult(value) {
  const result = snapshot(value, 'AEC measurement legend result');
  exactPlain(result, ['kind', 'schemaVersion', 'sourceDigest', 'sheetRevision', 'groups', 'recordCount'], 'AEC measurement legend result');
  if (result.kind !== 'aec-measurement-legend' || result.schemaVersion !== 1) invalid('AEC measurement legend result kind is invalid.');
  digest(result.sourceDigest, 'sourceDigest'); integer(result.sheetRevision, 'sheetRevision', 1, 1_000_000); integer(result.recordCount, 'recordCount', 1, MAX_RECORDS);
  exactArray(result.groups, 'groups', 1, MAX_RECORDS);
  const keys = ['toolId', 'styleId', 'kind', 'dimension', 'siUnit', 'displayUnit', 'calibrationId', 'count', 'totalSiValue', 'measurements', 'provenance'];
  const ids = new Set(); const provenance = new Set(); let previousGroupKey = '';
  for (const [index, group] of result.groups.entries()) {
    exactPlain(group, keys, `groups[${index}]`); identifier(group.toolId, `groups[${index}].toolId`); identifier(group.styleId, `groups[${index}].styleId`);
    if (!['distance', 'perimeter', 'area', 'count'].includes(group.kind) || !['length', 'area', 'count'].includes(group.dimension) || typeof group.siUnit !== 'string' || !group.siUnit || typeof group.displayUnit !== 'string' || !DISPLAY_UNITS.has(group.displayUnit)) invalid(`groups[${index}] has invalid measurement dimensions.`);
    const expectedDimension = group.kind === 'area' ? 'area' : group.kind === 'count' ? 'count' : 'length';
    const expectedSiUnit = group.kind === 'area' ? 'm2' : group.kind === 'count' ? 'count' : 'm';
    const validDisplayUnit = group.kind === 'area' ? AREA_DISPLAY_UNITS.has(group.displayUnit) : group.kind === 'count' ? group.displayUnit === 'count' : LENGTH_DISPLAY_UNITS.has(group.displayUnit);
    if (group.kind === 'count' ? (group.calibrationId !== null || group.dimension !== expectedDimension || group.siUnit !== expectedSiUnit || !validDisplayUnit) : (group.calibrationId === null || group.dimension !== expectedDimension || group.siUnit !== expectedSiUnit || !validDisplayUnit)) invalid(`groups[${index}] has inconsistent calibration or units.`);
    if (group.calibrationId !== null) identifier(group.calibrationId, `groups[${index}].calibrationId`);
    integer(group.count, `groups[${index}].count`, 1, MAX_RECORDS); if (typeof group.totalSiValue !== 'number' || !Number.isFinite(group.totalSiValue) || group.totalSiValue < 0 || group.totalSiValue > MAX_SUM) invalid(`groups[${index}] has an invalid aggregate.`);
    exactArray(group.measurements, `groups[${index}].measurements`, group.count, group.count); exactArray(group.provenance, `groups[${index}].provenance`, group.count, group.count);
    const groupKey = `${group.toolId}\u0000${group.styleId}\u0000${group.kind}\u0000${group.calibrationId ?? 'uncalibrated'}\u0000${group.dimension}\u0000${group.siUnit}\u0000${group.displayUnit}`;
    if (index > 0 && groupKey <= previousGroupKey) invalid('AEC legend groups are not deterministically sorted.');
    previousGroupKey = groupKey;
    let total = 0; let previousId = '';
    for (const [entryIndex, entry] of group.measurements.entries()) {
      exactPlain(entry, ['id', 'page', 'sheetId', 'kind', 'dimension', 'calibrationId', 'displayUnit', 'labelDigest', 'siValue', 'siUnit'], `groups[${index}].measurements[${entryIndex}]`); identifier(entry.id, 'measurement.id'); integer(entry.page, 'measurement.page', 1, 100_000); identifier(entry.sheetId, 'measurement.sheetId'); digest(entry.labelDigest, 'measurement.labelDigest');
      if (entry.kind !== group.kind || entry.dimension !== group.dimension || entry.calibrationId !== group.calibrationId || entry.displayUnit !== group.displayUnit || typeof entry.siValue !== 'number' || !Number.isFinite(entry.siValue) || entry.siValue < 0 || entry.siValue > MAX_SUM || entry.siUnit !== group.siUnit || (group.kind === 'count' && !Number.isSafeInteger(entry.siValue))) invalid('AEC legend measurement aggregate unit is invalid.');
      if (entryIndex > 0 && entry.id <= previousId) invalid('AEC legend measurements are not deterministically sorted.');
      previousId = entry.id; if (ids.has(entry.id)) invalid('AEC legend contains duplicate measurement IDs.'); ids.add(entry.id); total += entry.siValue; if (!Number.isFinite(total) || total > MAX_SUM) invalid('AEC legend aggregate exceeds the supported finite range.');
    }
    if (total !== group.totalSiValue || (group.kind === 'count' && !Number.isSafeInteger(group.totalSiValue))) invalid('AEC legend aggregate does not equal its measurement values.');
    for (const [entryIndex, entry] of group.provenance.entries()) {
      exactPlain(entry, ['id', 'provenanceSha256', 'sourceSha256', 'page', 'revision'], `groups[${index}].provenance[${entryIndex}]`); identifier(entry.id, 'provenance.id'); digest(entry.provenanceSha256, 'provenance.provenanceSha256'); digest(entry.sourceSha256, 'provenance.sourceSha256'); integer(entry.page, 'provenance.page', 1, 100_000); integer(entry.revision, 'provenance.revision', 1, 1_000_000); if (entry.sourceSha256 !== result.sourceDigest || entry.revision !== result.sheetRevision || entry.id !== result.groups[index].measurements[entryIndex].id || entry.page !== result.groups[index].measurements[entryIndex].page || provenance.has(entry.provenanceSha256)) invalid('AEC legend provenance is not source- or record-bound.'); provenance.add(entry.provenanceSha256);
    }
  }
  if (result.groups.reduce((sum, group) => sum + group.count, 0) !== result.recordCount) invalid('AEC legend group counts do not match recordCount.');
  return deepFreeze(result);
}
