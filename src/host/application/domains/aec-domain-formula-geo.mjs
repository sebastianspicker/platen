import { digest, fail, finiteRecord, id, number, point, text } from './aec-collaboration-support.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SPACE_COORDINATE = 1_000_000;
const MAX_CUSTOM_COLUMN_VARIABLES = 32;
const MAX_CUSTOM_FORMULA_LENGTH = 500;
const CALIBRATION_MODEL = 'local-affine-page-v1';

function tokenizeFormula(formula) {
  const source = text(formula, 'formula', MAX_CUSTOM_FORMULA_LENGTH);
  const tokens = /\s*(?:([A-Za-z][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)|([()+\-*/]))\s*/y;
  const parsed = [];
  const variables = [];
  let at = 0;
  while (at < source.length) {
    tokens.lastIndex = at;
    const token = tokens.exec(source);
    if (!token || token.index !== at) fail('INVALID_FORMULA', 'Formula contains an unsupported token.');
    const tokenValue = token[1] ?? token[2] ?? token[3];
    parsed.push(tokenValue);
    if (token[1]) variables.push(tokenValue);
    at = tokens.lastIndex;
  }
  if (!parsed.length) fail('INVALID_FORMULA', 'Formula must contain at least one token.');
  return { parsed, variables };
}

export function evaluateFormula(formula, values, { allowUnknownColumns = false, syntaxOnly = false } = {}) {
  const { parsed } = tokenizeFormula(formula);
  let cursor = 0;
  const parsePrimary = () => {
    const token = parsed[cursor++];
    if (token === '(') {
      const result = parseExpression();
      if (parsed[cursor++] !== ')') fail('INVALID_FORMULA', 'Formula has unbalanced parentheses.');
      return result;
    }
    if (/^\d/.test(token ?? '')) return Number(token);
    if (/^[A-Za-z]/.test(token ?? '')) {
      if (!Object.hasOwn(values, token)) {
        if (allowUnknownColumns) return syntaxOnly ? 1 : 0;
        fail('UNKNOWN_FORMULA_COLUMN', 'Formula references an unavailable numeric column.');
      }
      if (!Number.isFinite(values[token])) {
        fail('UNKNOWN_FORMULA_COLUMN', 'Formula references an unavailable numeric column.');
      }
      return values[token];
    }
    if (token === '-') return -parsePrimary();
    if (token === '+') return parsePrimary();
    fail('INVALID_FORMULA', 'Formula is incomplete.');
  };
  const parseProduct = () => {
    let result = parsePrimary();
    while (['*', '/'].includes(parsed[cursor])) {
      const operator = parsed[cursor++];
      const right = parsePrimary();
      if (!syntaxOnly && operator === '/' && right === 0) fail('FORMULA_DIVIDE_BY_ZERO', 'Formula cannot divide by zero.');
      result = syntaxOnly ? 1 : (operator === '*' ? result * right : result / right);
    }
    return result;
  };
  const parseExpression = () => {
    let result = parseProduct();
    while (['+', '-'].includes(parsed[cursor])) {
      const operator = parsed[cursor++];
      const right = parseProduct();
      result = syntaxOnly ? 1 : (operator === '+' ? result + right : result - right);
    }
    return result;
  };
  const result = parseExpression();
  if (cursor !== parsed.length || (!syntaxOnly && !Number.isFinite(result))) {
    fail('INVALID_FORMULA', 'Formula must produce a finite numeric result.');
  }
  return result;
}

function ensureCustomColumnVariables(formula) {
  const { variables } = tokenizeFormula(formula);
  const unique = [...new Set(variables)].sort((a, b) => a.localeCompare(b));
  if (unique.length === 0 || unique.length > MAX_CUSTOM_COLUMN_VARIABLES) {
    fail('INVALID_FORMULA', 'Custom column formulas must reference 1 to 32 variables.');
  }
  return unique;
}

function validateSourceBoundColumnRow(values, variables) {
  const row = finiteRecord(values, 'values');
  if (Object.keys(row).length !== variables.length) fail('INVALID_INPUT', 'Formula row must contain exactly the required variables.');
  const variableSet = new Set(variables);
  for (const key of Object.keys(row)) {
    if (!variableSet.has(key)) fail('INVALID_INPUT', 'Formula row contains invalid or unexpected variables.');
  }
  const normalized = {};
  for (const variable of variables) {
    if (!Object.hasOwn(row, variable)) fail('INVALID_INPUT', 'Formula row is missing required variables.');
    const value = row[variable];
    if (!Number.isFinite(value) || value < -1e12 || value > 1e12) fail('INVALID_INPUT', 'Formula row values must be finite numbers between -1e12 and 1e12.');
    normalized[variable] = value;
  }
  return normalized;
}

function assertBoundRevision(document, expectedRevision, revisionLabel) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail('REVISION_CONFLICT', `${revisionLabel} requires the current workspace revision.`, 409);
  }
  if (expectedRevision !== document.revision) {
    fail('REVISION_CONFLICT', `${revisionLabel} requires the current workspace revision.`, 409);
  }
}

function assertSourceBoundCalibration(record, label) {
  if (record.type !== 'geo-calibration') fail('INVALID_CALIBRATION', `${label} is not a geospatial calibration.`);
  if (record.model !== CALIBRATION_MODEL) fail('INVALID_CALIBRATION', `${label} has an unsupported calibration model.`);
  if (!record.sourceSha256 || !SHA256.test(record.sourceSha256)) fail('INVALID_CALIBRATION', `${label} source binding is invalid.`);
  if (!Number.isSafeInteger(record.page) || record.page < 1 || record.page > 100000) fail('INVALID_CALIBRATION', `${label} has an unsupported page.`);
  if (typeof record.origin !== 'object' || record.origin === null || Array.isArray(record.origin)) {
    fail('INVALID_CALIBRATION', `${label} has an invalid origin.`);
  }
  const origin = point(record.origin);
  if (origin.x < -MAX_SPACE_COORDINATE || origin.x > MAX_SPACE_COORDINATE
    || origin.y < -MAX_SPACE_COORDINATE || origin.y > MAX_SPACE_COORDINATE) {
    fail('INVALID_CALIBRATION', `${label} has an invalid origin.`);
  }
  if (typeof record.scale !== 'number' || !Number.isFinite(record.scale) || record.scale <= 0 || record.scale > 100000) {
    fail('INVALID_CALIBRATION', `${label} has an invalid scale.`);
  }
  number(record.rotation, `${label} rotation`, { min: -360, max: 360 });
}

export function createCustomColumn(domain, documentId, {
  id: suppliedId, name, formula, sourceSha256,
}, options = {}) {
  const safeFormula = text(formula, 'formula', MAX_CUSTOM_FORMULA_LENGTH);
  const sourceBound = sourceSha256 !== undefined;
  if (sourceBound) {
    const snapshot = domain.snapshot(documentId);
    assertBoundRevision(snapshot, options.expectedRevision, 'Custom column creation');
    evaluateFormula(safeFormula, {}, { allowUnknownColumns: true, syntaxOnly: true });
    const variables = ensureCustomColumnVariables(safeFormula);
    const record = {
      id: domain.newId('column', suppliedId),
      type: 'custom-column',
      name: text(name, 'name'),
      formula: safeFormula,
      sourceSha256: digest(sourceSha256, 'sourceSha256'),
      basisRevision: options.expectedRevision,
      variables,
      createdAt: domain.now(),
    };
    return domain.write(documentId, 'metadata', record, options.expectedRevision);
  }
  evaluateFormula(safeFormula, {}, { allowUnknownColumns: true });
  return domain.write(documentId, 'metadata', {
    id: domain.newId('column', suppliedId),
    type: 'custom-column',
    name: text(name, 'name'),
    formula: safeFormula,
    createdAt: domain.now(),
  }, options.expectedRevision);
}

export function evaluateCustomColumn(domain, documentId, columnId, values, options = {}) {
  const column = domain.get(documentId, 'metadata', id(columnId, 'columnId'));
  if (column.type !== 'custom-column') fail('INVALID_COLUMN', 'Record is not a custom column.');
  if (column.sourceSha256 === undefined) {
    return evaluateFormula(column.formula, finiteRecord(values, 'values'));
  }
  const snapshot = domain.snapshot(documentId);
  const sourceSha256 = digest(options.sourceSha256, 'sourceSha256');
  if (sourceSha256 !== column.sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'Source-bound custom column source digest does not match the current document.', 409);
  assertBoundRevision(snapshot, options.expectedRevision, 'Custom column evaluation');
  const formulaVariables = ensureCustomColumnVariables(column.formula);
  if (!Array.isArray(column.variables) || column.variables.length === 0) {
    fail('INVALID_COLUMN', 'Custom column metadata is missing source-bound variables.');
  }
  const stableVariables = [...new Set(column.variables)].sort((a, b) => a.localeCompare(b));
  if (formulaVariables.length !== stableVariables.length || formulaVariables.some((value, index) => value !== stableVariables[index])) {
    fail('INVALID_COLUMN', 'Custom column formula binding is invalid.');
  }
  const row = validateSourceBoundColumnRow(values, stableVariables);
  const result = evaluateFormula(column.formula, row);
  if (!Number.isFinite(result)) fail('INVALID_FORMULA', 'Formula evaluation result must be finite.');
  return {
    kind: 'source-bound-aec-custom-column-result',
    schemaVersion: 1,
    columnId: column.id,
    name: column.name,
    sourceSha256: column.sourceSha256,
    workspaceRevision: snapshot.revision,
    variables: stableVariables,
    row,
    result,
  };
}

export function calibrateGeoPage(domain, documentId, {
  id: suppliedId, page, origin, scale, rotation = 0, sourceSha256,
}, options = {}) {
  const sourceBound = sourceSha256 !== undefined;
  if (sourceBound) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) fail('INVALID_NUMBER', 'page must be a safe integer from 1 to 100000.');
    const x = number(origin?.x, 'origin.x', { min: -MAX_SPACE_COORDINATE, max: MAX_SPACE_COORDINATE });
    const y = number(origin?.y, 'origin.y', { min: -MAX_SPACE_COORDINATE, max: MAX_SPACE_COORDINATE });
    if (!Number.isFinite(scale) || scale <= 0 || scale > 100000) fail('INVALID_NUMBER', 'scale must be greater than 0 and at most 100000.');
    if (!Number.isFinite(rotation) || rotation < -360 || rotation > 360) fail('INVALID_NUMBER', 'rotation must be between -360 and 360.');
    const snapshot = domain.snapshot(documentId);
    assertBoundRevision(snapshot, options.expectedRevision, 'Geospatial calibration creation');
    return domain.write(documentId, 'metadata', {
      id: domain.newId('geo', suppliedId),
      type: 'geo-calibration',
      page,
      sourceSha256: digest(sourceSha256, 'sourceSha256'),
      basisRevision: snapshot.revision,
      model: CALIBRATION_MODEL,
      origin: { x, y },
      scale: number(scale, 'scale', { min: Number.MIN_VALUE, max: 100000 }),
      rotation: number(rotation, 'rotation', { min: -360, max: 360 }),
      createdAt: domain.now(),
    }, options.expectedRevision);
  }
  return domain.write(documentId, 'metadata', {
    id: domain.newId('geo', suppliedId),
    type: 'geo-calibration',
    page: number(page, 'page', { min: 1, positive: true }),
    origin: point(origin),
    scale: number(scale, 'scale', { positive: true, max: 100000 }),
    rotation: number(rotation, 'rotation', { min: -360, max: 360 }),
    createdAt: domain.now(),
  }, options.expectedRevision);
}

function convertPagePoint(record, value) {
  const radians = record.rotation * Math.PI / 180;
  const x = value.x * record.scale;
  const y = value.y * record.scale;
  return {
    x: record.origin.x + x * Math.cos(radians) - y * Math.sin(radians),
    y: record.origin.y + x * Math.sin(radians) + y * Math.cos(radians),
  };
}

export function pageToGeo(domain, documentId, calibrationId, pagePoint, options = {}) {
  const record = domain.get(documentId, 'metadata', id(calibrationId, 'calibrationId'));
  const value = point(pagePoint);
  if (record.type !== 'geo-calibration') fail('INVALID_CALIBRATION', 'Record is not a geospatial calibration.');
  if (record.sourceSha256 === undefined) return convertPagePoint(record, value);
  const sourceSha256 = digest(options.sourceSha256, 'sourceSha256');
  const snapshot = domain.snapshot(documentId);
  if (sourceSha256 !== record.sourceSha256) fail('SOURCE_VERSION_MISMATCH', 'Source-bound calibration source digest does not match the current document.', 409);
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0 || options.expectedRevision !== snapshot.revision) {
    fail('REVISION_CONFLICT', 'Source-bound geospatial conversion requires the current workspace revision.', 409);
  }
  assertSourceBoundCalibration(record, 'Geospatial calibration');
  const coordinate = convertPagePoint(record, value);
  if (!Number.isFinite(coordinate.x) || !Number.isFinite(coordinate.y)) fail('INVALID_CALCULATION', 'Geospatial conversion result is not finite.');
  return {
    kind: 'source-bound-aec-affine-coordinate',
    schemaVersion: 1,
    model: record.model,
    calibrationId: record.id,
    page: record.page,
    sourceSha256: record.sourceSha256,
    workspaceRevision: snapshot.revision,
    pagePoint: value,
    coordinate,
  };
}
