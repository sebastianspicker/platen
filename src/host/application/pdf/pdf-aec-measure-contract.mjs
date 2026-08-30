const MAX_PAGES = 100;
const MAX_POINTS = 50;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LENGTH_UNITS = new Set(['mm', 'cm', 'm', 'in', 'ft']);
const UNIT_METERS = Object.freeze({ mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 });

function unsupported() {
  const error = new Error('PDF is outside the supported bounded AEC measure-dictionary subset.');
  error.code = 'UNSUPPORTED_AEC_MEASURE_DICTIONARY_PDF';
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000;
}

function point(value) {
  if (!exactKeys(value, ['x', 'y']) || !finite(value.x) || !finite(value.y)) throw unsupported();
  return Object.freeze({ x: value.x, y: value.y });
}

function box(value) {
  if (!exactKeys(value, ['left', 'bottom', 'right', 'top'])
    || !Object.values(value).every(finite)
    || value.left >= value.right || value.bottom >= value.top) throw unsupported();
  return Object.freeze([value.left, value.bottom, value.right, value.top]);
}

function inside(pageBox, value) {
  return value.x >= pageBox[0] && value.x <= pageBox[2]
    && value.y >= pageBox[1] && value.y <= pageBox[3];
}

function distance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function polylineLength(points, closed) {
  let total = points.slice(1)
    .reduce((sum, value, index) => sum + distance(points[index], value), 0);
  if (closed) total += distance(points.at(-1), points[0]);
  return total;
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, value, index) => {
    const next = points[(index + 1) % points.length];
    return sum + (value.x * next.y) - (next.x * value.y);
  }, 0)) / 2;
}

function closeEnough(left, right) {
  return Math.abs(left - right)
    <= Math.max(0.000001, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
}

export function normalizeAecMeasureDictionaryInput(value) {
  try {
    if (!exactKeys(value, ['measurement', 'calibration'])) throw unsupported();
    const { measurement, calibration } = value;
    if (!plainObject(measurement) || !plainObject(calibration)
      || !IDENTIFIER.test(measurement.id ?? '')
      || !IDENTIFIER.test(measurement.calibrationId ?? '')
      || measurement.calibrationId !== calibration.id
      || !['distance', 'perimeter', 'area'].includes(measurement.kind)
      || !plainObject(measurement.source) || !Number.isSafeInteger(measurement.source.page)
      || measurement.source.page < 1 || measurement.source.page > MAX_PAGES
      || !plainObject(measurement.geometry) || measurement.geometry.space !== 'pdf-user-space-v1'
      || !Array.isArray(measurement.geometry.points)
      || !plainObject(measurement.result) || !finite(measurement.result.siValue)
      || !plainObject(calibration.knownLength)
      || !LENGTH_UNITS.has(calibration.knownLength.unit)
      || !finite(calibration.knownLength.value) || calibration.knownLength.value <= 0
      || !finite(calibration.metersPerPdfPoint) || calibration.metersPerPdfPoint <= 0
      || !Array.isArray(calibration.segment) || calibration.segment.length !== 2) throw unsupported();
    const pageBox = box(measurement.source.box);
    const points = Object.freeze(measurement.geometry.points.map(point));
    const segment = Object.freeze(calibration.segment.map(point));
    const minimum = measurement.kind === 'distance' ? 2 : 3;
    if (points.length < minimum || points.length > MAX_POINTS
      || [...points, ...segment].some((entry) => !inside(pageBox, entry))) throw unsupported();
    const calibrationDistance = distance(segment[0], segment[1]);
    const expectedScale = calibration.knownLength.value
      * UNIT_METERS[calibration.knownLength.unit] / calibrationDistance;
    if (calibrationDistance <= 0
      || !closeEnough(calibration.metersPerPdfPoint, expectedScale)) throw unsupported();
    const expectedQuantity = measurement.kind === 'area'
      ? polygonArea(points) * calibration.metersPerPdfPoint ** 2
      : polylineLength(points, measurement.kind !== 'distance') * calibration.metersPerPdfPoint;
    const expectedUnit = measurement.kind === 'area' ? 'm2' : 'm';
    if (expectedQuantity <= 0 || measurement.result.siUnit !== expectedUnit
      || !closeEnough(measurement.result.siValue, expectedQuantity)) throw unsupported();
    return Object.freeze({
      measurementId: measurement.id,
      calibrationId: calibration.id,
      page: measurement.source.page,
      kind: measurement.kind,
      points,
      pageBox,
      quantity: measurement.result.siValue,
      unit: expectedUnit,
      calibrationDistance,
      calibrationRealLength: calibration.knownLength.value,
      calibrationUnit: calibration.knownLength.unit,
      metersPerPdfPoint: calibration.metersPerPdfPoint,
      annotationSubtype: measurement.kind === 'distance' && points.length === 2 ? 'Line' : 'Ink',
    });
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_AEC_MEASURE_DICTIONARY_PDF') throw error;
    throw unsupported();
  }
}
