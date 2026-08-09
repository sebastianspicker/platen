import { createHash } from 'node:crypto';
import {
  LocalWorkspaceDomain, digest, fail, finiteRecord, id, list, number, point, points, text,
} from './aec-collaboration-support.mjs';
import { assertGeometry, polygonArea } from '../aec-artifact-validation.mjs';
import {
  calibrateGeoPage as performCalibrateGeoPage,
  createCustomColumn as performCreateCustomColumn,
  evaluateCustomColumn as performEvaluateCustomColumn,
  pageToGeo as performPageToGeo,
} from './aec-domain-formula-geo.mjs';
import { createBatchPlan as performCreateBatchPlan } from './aec-batch-slip-sheet.mjs';
import { createDrawingSet as performCreateDrawingSet } from './aec-drawing-set-log.mjs';
import { createMarkupToolset as performCreateMarkupToolset } from './aec-markup-toolset.mjs';
import { measurementToolset as performMeasurementToolset } from './aec-measurement-toolset.mjs';
import { createRevisionOverlay as performCreateRevisionOverlay } from './aec-revision-overlay.mjs';
import { createReviewSession as performCreateReviewSession } from './aec-review-session.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SPACE_COORDINATE = 1_000_000;
const MEASUREMENT_CONTRACT = Object.freeze({
  area: Object.freeze({ dimension: 'area', unit: 'm2' }),
  count: Object.freeze({ dimension: 'count', unit: 'count' }),
  distance: Object.freeze({ dimension: 'length', unit: 'm' }),
  perimeter: Object.freeze({ dimension: 'length', unit: 'm' }),
});
const SOURCE_BOUND_SPACE_KINDS = Object.freeze(new Set(['space', 'region']));

function roundMetric(value) {
  if (!Number.isFinite(value)) fail('INVALID_GEOMETRY', 'Geometry metrics must be finite.');
  return Number(value.toFixed(6));
}

function validateSourceBoundKind(kind) {
  const value = text(kind, 'kind');
  if (!SOURCE_BOUND_SPACE_KINDS.has(value)) fail('INVALID_KIND', 'Space kind must be space or region.');
  return value;
}

function isPlainPoint(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_POINT', `${label} must be a plain point object.`);
  return value;
}

function validateSourceBoundPoint(value, label) {
  const pointValue = isPlainPoint(value, label);
  const keys = Object.keys(pointValue);
  if (keys.length !== 2 || !Object.hasOwn(pointValue, 'x') || !Object.hasOwn(pointValue, 'y')) fail('INVALID_POINT', `${label} must contain only x and y.`);
  return {
    x: number(pointValue.x, `${label}.x`, { min: -MAX_SPACE_COORDINATE, max: MAX_SPACE_COORDINATE }),
    y: number(pointValue.y, `${label}.y`, { min: -MAX_SPACE_COORDINATE, max: MAX_SPACE_COORDINATE }),
  };
}

function sourceBoundPerimeterPdfPoints(pointsToMeasure) {
  let perimeter = 0;
  for (let index = 0; index < pointsToMeasure.length; index += 1) {
    const current = pointsToMeasure[index];
    const next = pointsToMeasure[(index + 1) % pointsToMeasure.length];
    perimeter += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return perimeter;
}

function sourceBoundMetrics(polygonPoints) {
  const uniqueVertices = new Set(polygonPoints.map(({ x, y }) => `${x}\u0000${y}`));
  if (uniqueVertices.size !== polygonPoints.length) {
    fail('AEC_GEOMETRY_DEGENERATE', 'Space geometry must not repeat vertices.');
  }
  assertGeometry('area', polygonPoints);
  return {
    areaPdfPoints2: roundMetric(Math.abs(polygonArea(polygonPoints))),
    perimeterPdfPoints: roundMetric(sourceBoundPerimeterPdfPoints(polygonPoints)),
  };
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function measurementSourceDigest(measurement, reference) {
  const source = measurement?.source;
  const shaA = source?.sha256;
  const shaB = source?.documentSha256;
  if (shaA !== undefined && shaB !== undefined && shaA !== shaB) fail('INVALID_MEASUREMENT', `Takeoff measurement ${reference} source binding is inconsistent.`);
  const value = typeof shaA === 'string' ? shaA.toLowerCase() : (typeof shaB === 'string' ? shaB.toLowerCase() : '');
  if (!SHA256.test(value)) fail('INVALID_MEASUREMENT', `Takeoff measurement ${reference} source binding is invalid.`);
  return value;
}

function measurementQuantity(measurement, reference) {
  const result = measurement?.result;
  if (!result || typeof result !== 'object') fail('INVALID_MEASUREMENT', `Takeoff measurement ${reference} result payload is malformed.`);
  const value = result.siValue;
  const expected = MEASUREMENT_CONTRACT[measurement?.kind];
  if (!expected || result.dimension !== expected.dimension || result.siUnit !== expected.unit) {
    fail('INVALID_MEASUREMENT', `Takeoff measurement ${reference} has incompatible kind, dimension, or SI unit.`);
  }
  if (!Number.isFinite(value) || value < 0 || value > 1e12) fail('INVALID_MEASUREMENT', `Takeoff measurement ${reference} has invalid quantity.`);
  if (measurement.kind === 'count' && (!Number.isSafeInteger(value) || measurement.calibrationId !== null)) {
    fail('INVALID_MEASUREMENT', `Takeoff measurement ${reference} has invalid count semantics.`);
  }
  return { unit: expected.unit, value };
}

function measurementProvenance(measurement, reference, required) {
  const provenance = measurement?.provenanceSha256;
  if (typeof provenance === 'string' && SHA256.test(provenance)) return provenance;
  if (provenance !== undefined) fail('INVALID_MEASUREMENT', `Takeoff measurement ${reference} has invalid provenance digest.`);
  if (required) fail('INVALID_MEASUREMENT', `Takeoff measurement ${reference} is missing provenance evidence.`);
  const sourceSha256 = measurementSourceDigest(measurement, reference);
  return createHash('sha256')
    .update(canonicalize({
      id: measurement?.id,
      sourceSha256,
      result: measurement?.result,
      createdAt: measurement?.createdAt,
    }))
    .digest('hex');
}


function assertBoundRevision(document, expectedRevision, revisionLabel) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail('REVISION_CONFLICT', `${revisionLabel} requires the current workspace revision.`, 409);
  }
  if (expectedRevision !== document.revision) {
    fail('REVISION_CONFLICT', `${revisionLabel} requires the current workspace revision.`, 409);
  }
}

/** Local AEC metadata, markup, drawing, and takeoff records. Source-bound measurements belong to AecArtifactService. */
export class AecDomain extends LocalWorkspaceDomain {
  constructor(workspaceStateStore, options) { super(workspaceStateStore, options, 'aec'); }

  createToolset(documentId, {
    id: suppliedId, name, tools, sourceSha256,
  }, options = {}) {
    return performCreateMarkupToolset(this, documentId, {
      id: suppliedId, name, tools, sourceSha256,
    }, options);
  }
  createReviewSession(documentId, input, options = {}) {
    return performCreateReviewSession(this, documentId, input, options);
  }
  measurementToolset(documentId, input, options = {}) {
    return performMeasurementToolset(this, documentId, input, options);
  }
  createMarkup(documentId, {
    id: suppliedId, type, status = 'open', page, properties = {}, sourceSha256,
  }, options = {}) {
    const record = {
      id: this.newId('markup', suppliedId),
      type: 'markup',
      markupType: text(type, 'type'),
      status: text(status, 'status'),
      page: number(page, 'page', { min: 1, positive: true }),
      properties: finiteRecord(properties, 'properties'),
      createdAt: this.now(),
    };
    if (sourceSha256 !== undefined) {
      record.sourceSha256 = digest(sourceSha256, 'sourceSha256');
      if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
        fail('REVISION_CONFLICT', 'Source-bound markup creation requires the current workspace revision.', 409);
      }
      record.basisRevision = options.expectedRevision;
    }
    return this.write(documentId, 'annotations', record, options.expectedRevision);
  }
  listMarkups(documentId, { type, status, page, sourceSha256, expectedRevision } = {}) {
    const snapshot = this.snapshot(documentId);
    const exact = sourceSha256 !== undefined || expectedRevision !== undefined;
    const source = exact ? digest(sourceSha256, 'sourceSha256') : null;
    if (exact && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== snapshot.revision)) {
      fail('REVISION_CONFLICT', 'Markup listing requires the current workspace revision.', 409);
    }
    const markups = snapshot.namespaces.annotations
      .filter((item) => item.type === 'markup')
      .filter((item) => (!type || item.markupType === type)
        && (!status || item.status === status)
        && (!page || item.page === page)
        && (!exact || item.sourceSha256 === source))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!exact) return markups;
    const byType = {}; const byStatus = {};
    for (const markup of markups) {
      byType[markup.markupType] = (byType[markup.markupType] ?? 0) + 1;
      byStatus[markup.status] = (byStatus[markup.status] ?? 0) + 1;
    }
    return {
      kind: 'source-bound-aec-markup-list',
      schemaVersion: 1,
      sourceSha256: source,
      workspaceRevision: snapshot.revision,
      filters: { type: type ?? null, status: status ?? null, page: page ?? null },
      count: markups.length,
      byType: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))),
      byStatus: Object.fromEntries(Object.entries(byStatus).sort(([a], [b]) => a.localeCompare(b))),
      markups,
    };
  }
  createCustomColumn(documentId, {
    id: suppliedId, name, formula, sourceSha256,
  }, options = {}) {
    return performCreateCustomColumn(this, documentId, { id: suppliedId, name, formula, sourceSha256 }, options);
  }
  evaluateCustomColumn(documentId, columnId, values, options = {}) {
    return performEvaluateCustomColumn(this, documentId, columnId, values, options);
  }
  createSpace(documentId, {
    id: suppliedId, name, points: rawPoints, kind = 'space', sourceSha256, page,
  }, options = {}) {
    const sourceBound = sourceSha256 !== undefined;
    if (!sourceBound) {
      const record = {
        id: this.newId('space', suppliedId),
        type: 'space-region',
        kind: text(kind, 'kind'),
        name: text(name, 'name'),
        points: points(rawPoints, 3),
        createdAt: this.now(),
      };
      return this.write(documentId, 'metadata', record, options.expectedRevision);
    }
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) fail('INVALID_NUMBER', 'page must be a safe integer from 1 to 100000.');
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
      fail('REVISION_CONFLICT', 'Source-bound space creation requires the current workspace revision.', 409);
    }
    const snapshot = this.snapshot(documentId);
    if (options.expectedRevision !== snapshot.revision) fail('REVISION_CONFLICT', 'Source-bound space creation requires the current workspace revision.', 409);
    const pointsToPersist = list(rawPoints, 'points', 200).map((value, index) => validateSourceBoundPoint(value, `points[${index}]`));
    if (pointsToPersist.length < 3) fail('INVALID_GEOMETRY', 'At least 3 points are required for a space region.');
    assertGeometry('area', pointsToPersist);
    const metrics = sourceBoundMetrics(pointsToPersist);
    const record = {
      id: this.newId('space', suppliedId),
      type: 'space-region',
      kind: validateSourceBoundKind(kind),
      name: text(name, 'name'),
      page,
      sourceSha256: digest(sourceSha256, 'sourceSha256'),
      basisRevision: snapshot.revision,
      points: pointsToPersist,
      metrics,
      createdAt: this.now(),
    };
    return this.write(documentId, 'metadata', record, options.expectedRevision);
  }
  createDrawingSet(documentId, input, options = {}) {
    return performCreateDrawingSet(this, documentId, input, options);
  }
  createSheet(documentId, {
    id: suppliedId, number: sheetNumber, title, tags = [], page, sourceSha256,
  }, options = {}) {
    const record = {
      id: this.newId('sheet', suppliedId), type: 'sheet', number: text(sheetNumber, 'number'),
      title: text(title, 'title'), tags: list(tags, 'tags', 50).map((tag) => text(tag, 'tag', 80)),
      createdAt: this.now(),
    };
    if (sourceSha256 !== undefined) {
      record.sourceSha256 = digest(sourceSha256, 'sourceSha256');
      if (!Number.isSafeInteger(page)) {
        fail('INVALID_NUMBER', 'page must be a positive safe integer.');
      }
      record.page = number(page, 'page', { min: 1, max: 100_000, positive: true });
      if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
        fail('REVISION_CONFLICT', 'Source-bound sheet creation requires the current workspace revision.', 409);
      }
      record.basisRevision = options.expectedRevision;
    }
    return this.write(documentId, 'reviewRecords', record, options.expectedRevision);
  }
  createRevisionOverlay(documentId, {
    id: suppliedId, fromDigest, toDigest, sheetId, sourceSha256,
  }, options = {}) {
    return performCreateRevisionOverlay(this, documentId, {
      id: suppliedId, fromDigest, toDigest, sheetId, sourceSha256,
    }, options);
  }
  createBatchPlan(documentId, {
    id: suppliedId, kind, pairs, sourceSha256,
  }, options = {}) {
    return performCreateBatchPlan(this, documentId, {
      id: suppliedId, kind, pairs, sourceSha256,
    }, options);
  }
  legends(documentId) { const result = {}; for (const markup of this.records(documentId, 'annotations', 'markup')) result[markup.markupType] = (result[markup.markupType] ?? 0) + 1; return result; }
  calibrateGeoPage(documentId, {
    id: suppliedId, page, origin, scale, rotation = 0, sourceSha256,
  }, options = {}) {
    return performCalibrateGeoPage(this, documentId, {
      id: suppliedId, page, origin, scale, rotation, sourceSha256,
    }, options);
  }
  pageToGeo(documentId, calibrationId, pagePoint, options = {}) {
    return performPageToGeo(this, documentId, calibrationId, pagePoint, options);
  }
  takeoff(documentId, { id: suppliedId, sourceSha256: requestedSourceSha256, measurementIds, group = 'default' }, options = {}) {
    const all = this.records(documentId, 'measurements', 'measurement');
    const ids = list(measurementIds, 'measurementIds', 100);
    if (ids.length === 0) fail('INVALID_MEASUREMENT_IDS', 'Takeoff requires between 1 and 100 measurements.');
    const seen = new Set();
    const requested = [];
    for (const measurementId of ids) {
      const value = id(measurementId, 'measurementId');
      if (seen.has(value)) fail('INVALID_MEASUREMENT_IDS', 'Takeoff references duplicate measurement identifiers.');
      seen.add(value);
      requested.push(value);
    }
    const basisRevision = this.snapshot(documentId).revision;
    const quantitiesByUnit = Object.create(null);
    const provenanceDigests = [];
    let aggregateSource;
    const expectedSource = requestedSourceSha256 === undefined ? undefined : digest(requestedSourceSha256, 'sourceSha256');
    const measurementIdsSorted = requested.sort();
    for (const measurementId of measurementIdsSorted) {
      const measurement = all.find((item) => item.id === measurementId);
      if (!measurement || measurement.type !== 'measurement' || measurement.schemaVersion !== 2) fail('AEC_MEASUREMENT_NOT_FOUND', 'Takeoff references a missing measurement.', 404);
      const recordSource = measurementSourceDigest(measurement, measurementId);
      if (aggregateSource === undefined) aggregateSource = recordSource;
      if (expectedSource !== undefined && expectedSource !== recordSource) fail('SOURCE_VERSION_MISMATCH', 'Takeoff source digest does not match measurement source binding.', 409);
      else if (aggregateSource !== recordSource) fail('INVALID_MEASUREMENT', 'Takeoff cannot mix source-bound measurements from different documents.');
      const { unit, value } = measurementQuantity(measurement, measurementId);
      quantitiesByUnit[unit] = (quantitiesByUnit[unit] ?? 0) + value;
      provenanceDigests.push(measurementProvenance(measurement, measurementId, expectedSource !== undefined));
    }
    const units = Object.keys(quantitiesByUnit).sort();
    const quantities = Object.fromEntries(units.map((unit) => [unit, quantitiesByUnit[unit]]));
    const provenanceDigest = createHash('sha256')
      .update(canonicalize({
        sourceSha256: aggregateSource,
        basisRevision,
        group: text(group, 'group'),
        measurementIds: measurementIdsSorted,
        measurementProvenanceDigests: provenanceDigests.sort(),
        quantities,
      }))
      .digest('hex');
    const record = {
      id: this.newId('takeoff', suppliedId),
      type: 'quantity-takeoff',
      group: text(group, 'group'),
      sourceSha256: aggregateSource,
      basisRevision,
      measurementIds: measurementIdsSorted,
      measurementProvenanceDigests: provenanceDigests.sort(),
      quantities,
      provenanceDigest,
      createdAt: this.now(),
    };
    return this.write(documentId, 'takeoffs', record, options.expectedRevision);
  }
}
