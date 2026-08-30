const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LENGTH_UNITS = new Set(['mm', 'cm', 'm', 'in', 'ft']);
const AREA_UNITS = new Set(['mm2', 'cm2', 'm2', 'in2', 'ft2']);
const KINDS = new Set(['distance', 'perimeter', 'area', 'count']);
const MAX_POINTS = 50;
const encoder = new TextEncoder();

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'AEC_CONTRACT_INVALID';
  throw error;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) {
    invalid(`${label} must contain exactly the supported fields.`);
  }
  return value;
}

function id(value, label) {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) invalid(`${label} must be a bounded opaque identifier.`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} is outside the supported range.`);
  return value;
}

function finite(value, label, minimum = -1_000_000, maximum = 1_000_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be a bounded finite number.`);
  }
  return value;
}

function text(value, label, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || encoder.encode(value).byteLength > maximum) {
    invalid(`${label} must be bounded non-empty text.`);
  }
  return value.trim();
}

function point(value, label) {
  exactObject(value, ['x', 'y'], label);
  return Object.freeze({ x: finite(value.x, `${label}.x`), y: finite(value.y, `${label}.y`) });
}

function pointList(value, label, minimum, maximum = MAX_POINTS) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalid(`${label} must contain ${minimum} through ${maximum} points.`);
  }
  return Object.freeze(value.map((entry, index) => point(entry, `${label}[${index}]`)));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function normalizeAecCalibrationRequest(value) {
  const input = exactObject(value, [
    'schemaVersion', 'sourceSha256', 'expectedRevision', 'id', 'page',
    'points', 'realLength', 'unit', 'label',
  ], 'AEC calibration request');
  if (input.schemaVersion !== 1) invalid('AEC calibration request schemaVersion must be 1.');
  const points = pointList(input.points, 'points', 2, 2);
  if (points[0].x === points[1].x && points[0].y === points[1].y) invalid('Calibration points must be distinct.');
  if (!LENGTH_UNITS.has(input.unit)) invalid('Calibration unit is unsupported.');
  return deepFreeze({
    schemaVersion: 1,
    sourceSha256: digest(input.sourceSha256, 'sourceSha256'),
    expectedRevision: integer(input.expectedRevision, 'expectedRevision', 0, 1_000_000),
    id: id(input.id, 'id'),
    page: integer(input.page, 'page', 1, 100_000),
    points,
    realLength: finite(input.realLength, 'realLength', Number.EPSILON, 1_000_000_000),
    unit: input.unit,
    label: text(input.label, 'label'),
  });
}

export function normalizeAecMeasurementRequest(value) {
  const input = exactObject(value, [
    'schemaVersion', 'sourceSha256', 'expectedRevision', 'id', 'page', 'kind',
    'points', 'calibrationId', 'label', 'displayUnit',
  ], 'AEC measurement request');
  if (input.schemaVersion !== 1 || !KINDS.has(input.kind)) invalid('AEC measurement kind or schema version is unsupported.');
  const minimum = input.kind === 'distance' ? 2 : input.kind === 'count' ? 1 : 3;
  const points = pointList(input.points, 'points', minimum);
  if (input.kind === 'count') {
    if (input.calibrationId !== null || input.displayUnit !== 'count') invalid('Count measurements do not use scale calibration and must use count units.');
  } else {
    id(input.calibrationId, 'calibrationId');
    if (input.kind === 'area' ? !AREA_UNITS.has(input.displayUnit) : !LENGTH_UNITS.has(input.displayUnit)) {
      invalid('Measurement display unit does not match its dimension.');
    }
  }
  return deepFreeze({
    schemaVersion: 1,
    sourceSha256: digest(input.sourceSha256, 'sourceSha256'),
    expectedRevision: integer(input.expectedRevision, 'expectedRevision', 0, 1_000_000),
    id: id(input.id, 'id'),
    page: integer(input.page, 'page', 1, 100_000),
    kind: input.kind,
    points,
    calibrationId: input.calibrationId,
    label: text(input.label, 'label'),
    displayUnit: input.displayUnit,
  });
}

export function normalizeAecMaterializationRequest(value) {
  const input = exactObject(value, ['schemaVersion', 'sourceSha256', 'expectedRevision', 'measurementId'], 'AEC materialization request');
  if (input.schemaVersion !== 1) invalid('AEC materialization request schemaVersion must be 1.');
  return deepFreeze({
    schemaVersion: 1,
    sourceSha256: digest(input.sourceSha256, 'sourceSha256'),
    expectedRevision: integer(input.expectedRevision, 'expectedRevision', 0, 1_000_000),
    measurementId: id(input.measurementId, 'measurementId'),
  });
}

function validSourceBinding(value) {
  if (!exactObject(value, ['sha256', 'page', 'displayBox', 'box', 'rotation', 'geometrySha256'], 'AEC source binding')) return false;
  digest(value.sha256, 'source.sha256');
  integer(value.page, 'source.page', 1, 100_000);
  if (value.displayBox !== 'crop') invalid('AEC source display box must be crop.');
  exactObject(value.box, ['left', 'bottom', 'right', 'top'], 'AEC source box');
  for (const key of ['left', 'bottom', 'right', 'top']) finite(value.box[key], `source.box.${key}`);
  if (value.box.right <= value.box.left || value.box.top <= value.box.bottom) invalid('AEC source box must have positive dimensions.');
  if (![0, 90, 180, 270].includes(value.rotation)) invalid('AEC source rotation is unsupported.');
  digest(value.geometrySha256, 'source.geometrySha256');
  return true;
}

export function validateAecCalibrationResult(value) {
  const output = exactObject(value, ['kind', 'schemaVersion', 'sourceDigest', 'workspaceRevision', 'calibration'], 'AEC calibration result');
  if (output.kind !== 'source-bound-aec-calibration' || output.schemaVersion !== 1) invalid('AEC calibration result kind is invalid.');
  digest(output.sourceDigest, 'sourceDigest');
  integer(output.workspaceRevision, 'workspaceRevision', 1, 1_000_000);
  const record = exactObject(output.calibration, [
    'schemaVersion', 'id', 'type', 'source', 'segment', 'knownLength',
    'metersPerPdfPoint', 'label', 'createdAt',
  ], 'AEC calibration record');
  if (record.schemaVersion !== 2 || record.type !== 'scale-calibration') invalid('AEC calibration record version is invalid.');
  id(record.id, 'calibration.id'); validSourceBinding(record.source);
  pointList(record.segment, 'calibration.segment', 2, 2);
  exactObject(record.knownLength, ['value', 'unit'], 'calibration.knownLength');
  finite(record.knownLength.value, 'knownLength.value', Number.EPSILON, 1_000_000_000);
  if (!LENGTH_UNITS.has(record.knownLength.unit)) invalid('Calibration unit is invalid.');
  finite(record.metersPerPdfPoint, 'metersPerPdfPoint', Number.EPSILON, 1_000_000);
  text(record.label, 'calibration.label');
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) invalid('Calibration timestamp is invalid.');
  return deepFreeze(output);
}

export function validateAecMeasurementResult(value) {
  const output = exactObject(value, ['kind', 'schemaVersion', 'sourceDigest', 'workspaceRevision', 'measurement'], 'AEC measurement result');
  if (output.kind !== 'source-bound-aec-measurement' || output.schemaVersion !== 1) invalid('AEC measurement result kind is invalid.');
  digest(output.sourceDigest, 'sourceDigest');
  integer(output.workspaceRevision, 'workspaceRevision', 1, 1_000_000);
  const record = exactObject(output.measurement, [
    'schemaVersion', 'id', 'type', 'source', 'calibrationId', 'kind', 'geometry',
    'result', 'label', 'provenanceSha256', 'createdAt',
  ], 'AEC measurement record');
  if (record.schemaVersion !== 2 || record.type !== 'measurement' || !KINDS.has(record.kind)) invalid('AEC measurement record version is invalid.');
  id(record.id, 'measurement.id'); validSourceBinding(record.source);
  if (record.kind === 'count') {
    if (record.calibrationId !== null) invalid('Count measurement calibration must be null.');
  } else id(record.calibrationId, 'measurement.calibrationId');
  exactObject(record.geometry, ['space', 'points'], 'measurement.geometry');
  if (record.geometry.space !== 'pdf-user-space-v1') invalid('Measurement coordinate space is invalid.');
  pointList(record.geometry.points, 'measurement.geometry.points', record.kind === 'count' ? 1 : record.kind === 'distance' ? 2 : 3);
  exactObject(record.result, ['dimension', 'siValue', 'siUnit', 'displayValue', 'displayUnit'], 'measurement.result');
  if (!['length', 'area', 'count'].includes(record.result.dimension)) invalid('Measurement dimension is invalid.');
  finite(record.result.siValue, 'measurement.result.siValue', 0, 1_000_000_000_000);
  finite(record.result.displayValue, 'measurement.result.displayValue', 0, 1_000_000_000_000);
  digest(record.provenanceSha256, 'measurement.provenanceSha256'); text(record.label, 'measurement.label');
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) invalid('Measurement timestamp is invalid.');
  return deepFreeze(output);
}

export function validateAecMaterializationResult(value) {
  const output = exactObject(value, ['kind', 'schemaVersion', 'sourceDigest', 'measurement', 'artifact', 'nativeReceipt', 'receipt', 'evidence', 'limitations'], 'AEC materialization result');
  if (output.kind !== 'pdf-native-aec-measurement' || output.schemaVersion !== 2) invalid('AEC materialization result kind is invalid.');
  digest(output.sourceDigest, 'sourceDigest');
  validateAecMeasurementResult({ kind: 'source-bound-aec-measurement', schemaVersion: 1, sourceDigest: output.sourceDigest, workspaceRevision: 1, measurement: output.measurement });
  if (!output.artifact || typeof output.artifact.id !== 'string' || !SHA256.test(output.artifact.sha256 ?? '')) invalid('AEC materialization artifact is invalid.');
  if (!output.nativeReceipt || output.nativeReceipt.schema !== 'pdfkit-aec-measurement-receipt-v1'
    || output.nativeReceipt.version !== 1 || output.nativeReceipt.operation !== 'applyAecMeasurement'
    || output.nativeReceipt.measurementDictionaryEmbedded !== false) invalid('AEC native materialization receipt is invalid.');
  if (!output.receipt || output.receipt.schema !== 'platen-aec-materialization-receipt-v2'
    || output.receipt.version !== 2 || output.receipt.operation !== 'applyAecMeasurement'
    || !SHA256.test(output.receipt.sourceSha256 ?? '') || !SHA256.test(output.receipt.outputSha256 ?? '')
    || output.receipt.sourceSha256 !== output.nativeReceipt.outputSha256
    || output.receipt.outputSha256 !== output.artifact.sha256
    || typeof output.receipt.measurementDictionaryEmbedded !== 'boolean') invalid('AEC materialization receipt is invalid.');
  if (output.measurement.kind === 'count' ? output.receipt.measurementDictionaryEmbedded : !output.receipt.measurementDictionaryEmbedded) invalid('AEC materialization receipt measurement-dictionary state is invalid.');
  exactObject(output.evidence, ['localOnly', 'sourceBound', 'nativeAnnotations', 'helperReopened', 'popplerParsed', 'allPagesRendered', 'sourceUnchanged'], 'AEC materialization evidence');
  if (Object.values(output.evidence).some((entry) => entry !== true)) invalid('AEC materialization evidence is incomplete.');
  if (!Array.isArray(output.limitations) || output.limitations.length < 1 || output.limitations.some((entry) => typeof entry !== 'string' || !entry)) invalid('AEC materialization limitations are invalid.');
  return deepFreeze(output);
}

export const AEC_LENGTH_UNITS = Object.freeze([...LENGTH_UNITS]);
export const AEC_AREA_UNITS = Object.freeze([...AREA_UNITS]);
export const AEC_MEASUREMENT_KINDS = Object.freeze([...KINDS]);
