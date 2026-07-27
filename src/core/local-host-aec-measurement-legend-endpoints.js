import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UNITS = new Set(['mm', 'cm', 'm', 'in', 'ft', 'mm2', 'cm2', 'm2', 'in2', 'ft2', 'count']);
function exact(value, keys) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)) && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true); }
function array(value, min = 0, max = 500) { return Array.isArray(value) && value.length >= min && value.length <= max && Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).length === value.length && Object.getOwnPropertyDescriptor(value, 'length')?.enumerable === false && Object.keys(Object.getOwnPropertyDescriptors(value)).filter((key) => key !== 'length').every((key) => { const d = Object.getOwnPropertyDescriptor(value, key); return d.enumerable === true && Object.hasOwn(d, 'value'); }); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function fail() { throw new TypeError('AEC measurement legend result is invalid.'); }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }
function validateResult(result, request) {
  if (!exact(result, ['kind', 'schemaVersion', 'sourceDigest', 'sheetRevision', 'groups', 'recordCount']) || result.kind !== 'aec-measurement-legend' || result.schemaVersion !== 1 || result.sourceDigest !== request.sourceSha256 || result.sheetRevision !== request.expectedRevision || !SHA256.test(result.sourceDigest ?? '') || !integer(result.sheetRevision, 1, 1_000_000) || !integer(result.recordCount, 1, 500) || !array(result.groups, 1)) fail();
  const ids = new Set(); const provenance = new Set(); let count = 0; let previous = '';
  for (const group of result.groups) {
    const expectedDimension = group.kind === 'area' ? 'area' : group.kind === 'count' ? 'count' : 'length'; const expectedSiUnit = group.kind === 'area' ? 'm2' : group.kind === 'count' ? 'count' : 'm';
    const validUnit = group.kind === 'count' ? group.displayUnit === 'count' : group.kind === 'area' ? ['mm2', 'cm2', 'm2', 'in2', 'ft2'].includes(group.displayUnit) : ['mm', 'cm', 'm', 'in', 'ft'].includes(group.displayUnit);
    if (!exact(group, ['toolId', 'styleId', 'kind', 'dimension', 'siUnit', 'displayUnit', 'calibrationId', 'count', 'totalSiValue', 'measurements', 'provenance']) || !ID.test(group.toolId) || !ID.test(group.styleId) || !['distance', 'perimeter', 'area', 'count'].includes(group.kind) || group.dimension !== expectedDimension || group.siUnit !== expectedSiUnit || typeof group.displayUnit !== 'string' || !UNITS.has(group.displayUnit) || !validUnit || (group.kind === 'count' ? group.calibrationId !== null && fail() : group.calibrationId === null && fail()) || (group.calibrationId !== null && !ID.test(group.calibrationId)) || !integer(group.count, 1, 500) || typeof group.totalSiValue !== 'number' || !Number.isFinite(group.totalSiValue) || group.totalSiValue < 0 || group.totalSiValue > 1_000_000_000_000 || !array(group.measurements, group.count, group.count) || !array(group.provenance, group.count, group.count)) fail();
    const key = `${group.toolId}\0${group.styleId}\0${group.kind}\0${group.calibrationId ?? 'uncalibrated'}\0${group.dimension}\0${group.siUnit}\0${group.displayUnit}`; if (key <= previous) fail(); previous = key; let total = 0; let previousId = '';
    for (const entry of group.measurements) { if (!exact(entry, ['id', 'page', 'sheetId', 'kind', 'dimension', 'calibrationId', 'displayUnit', 'labelDigest', 'siValue', 'siUnit']) || !ID.test(entry.id) || !integer(entry.page, 1, 100_000) || !ID.test(entry.sheetId) || entry.kind !== group.kind || entry.dimension !== group.dimension || entry.calibrationId !== group.calibrationId || entry.displayUnit !== group.displayUnit || !SHA256.test(entry.labelDigest ?? '') || typeof entry.siValue !== 'number' || !Number.isFinite(entry.siValue) || entry.siValue < 0 || entry.siValue > 1_000_000_000_000 || (group.kind === 'count' && !Number.isSafeInteger(entry.siValue)) || entry.siUnit !== group.siUnit || entry.id <= previousId || ids.has(entry.id)) fail(); previousId = entry.id; ids.add(entry.id); total += entry.siValue; if (total > 1_000_000_000_000) fail(); }
    if (total !== group.totalSiValue || (group.kind === 'count' && !Number.isSafeInteger(group.totalSiValue))) fail();
    for (const [provenanceIndex, entry] of group.provenance.entries()) { if (!exact(entry, ['id', 'provenanceSha256', 'sourceSha256', 'page', 'revision']) || !ID.test(entry.id) || !SHA256.test(entry.provenanceSha256 ?? '') || !SHA256.test(entry.sourceSha256 ?? '') || entry.sourceSha256 !== result.sourceDigest || !integer(entry.page, 1, 100_000) || entry.revision !== result.sheetRevision || entry.id !== group.measurements[provenanceIndex].id || provenance.has(entry.provenanceSha256)) fail(); provenance.add(entry.provenanceSha256); }
    count += group.count;
  }
  if (count !== result.recordCount) fail();
  return freeze(result);
}
export function createAecMeasurementLegendEndpoints({ json }) {
  return Object.freeze({
    generateAecMeasurementLegend(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('AEC measurement legend options are invalid.');
      const ids = request.measurementIds; const descriptors = ids && Object.getOwnPropertyDescriptors(ids);
      if (!exactObject(request, ['sourceSha256', 'expectedRevision', 'measurementIds']) || !SHA256.test(request.sourceSha256 ?? '') || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 || request.expectedRevision > 1_000_000 || !Array.isArray(ids) || ids.length < 1 || ids.length > 500 || Object.getOwnPropertySymbols(ids).length || Object.keys(ids).length !== ids.length || !descriptors?.length || descriptors.length.enumerable || descriptors.length.get || descriptors.length.set || Object.keys(descriptors).filter((key) => key !== 'length').some((key) => !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) || ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) || new Set(ids).size !== ids.length) throw new TypeError('AEC measurement legend request is invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/aec-measurement-legend`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: options.signal }).then((body) => validateResult(body?.result, request));
    },
  });
}
