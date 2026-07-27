import {
  LocalWorkspaceDomain, digest, fail, finiteRecord, id, list, number, point, points, text,
} from './aec-collaboration-support.mjs';

function evaluateFormula(formula, values, allowUnknownColumns = false) {
  const source = text(formula, 'formula', 500);
  const tokens = /\s*(?:([A-Za-z][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)|([()+\-*/]))\s*/y;
  const parsed = [];
  let at = 0;
  while (at < source.length) {
    tokens.lastIndex = at;
    const token = tokens.exec(source);
    if (!token || token.index !== at) fail('INVALID_FORMULA', 'Formula contains an unsupported token.');
    parsed.push(token[1] ?? token[2] ?? token[3]);
    at = tokens.lastIndex;
  }
  let cursor = 0;
  const primary = () => {
    const token = parsed[cursor++];
    if (token === '(') { const result = expression(); if (parsed[cursor++] !== ')') fail('INVALID_FORMULA', 'Formula has unbalanced parentheses.'); return result; }
    if (/^\d/.test(token ?? '')) return Number(token);
    if (/^[A-Za-z]/.test(token ?? '')) {
      if (!Object.hasOwn(values, token)) { if (allowUnknownColumns) return 0; fail('UNKNOWN_FORMULA_COLUMN', 'Formula references an unavailable numeric column.'); }
      if (!Number.isFinite(values[token])) fail('UNKNOWN_FORMULA_COLUMN', 'Formula references an unavailable numeric column.');
      return values[token];
    }
    if (token === '-') return -primary();
    fail('INVALID_FORMULA', 'Formula is incomplete.');
  };
  const product = () => { let result = primary(); while (['*', '/'].includes(parsed[cursor])) { const operator = parsed[cursor++]; const right = primary(); if (operator === '/' && right === 0) fail('FORMULA_DIVIDE_BY_ZERO', 'Formula cannot divide by zero.'); result = operator === '*' ? result * right : result / right; } return result; };
  const expression = () => { let result = product(); while (['+', '-'].includes(parsed[cursor])) { const operator = parsed[cursor++]; const right = product(); result = operator === '+' ? result + right : result - right; } return result; };
  const result = expression();
  if (cursor !== parsed.length || !Number.isFinite(result)) fail('INVALID_FORMULA', 'Formula must produce a finite numeric result.');
  return result;
}

/** Local AEC metadata, markup, drawing, and takeoff records. Source-bound measurements belong to AecArtifactService. */
export class AecDomain extends LocalWorkspaceDomain {
  constructor(workspaceStateStore, options) { super(workspaceStateStore, options, 'aec'); }

  createToolset(documentId, { id: suppliedId, name, tools }, options = {}) { const record = { id: this.newId('toolset', suppliedId), type: 'toolset', name: text(name, 'name'), tools: list(tools, 'tools', 50).map((tool) => text(tool, 'tool', 80)), createdAt: this.now() }; return this.write(documentId, 'metadata', record, options.expectedRevision); }
  createMarkup(documentId, { id: suppliedId, type, status = 'open', page, properties = {} }, options = {}) { const record = { id: this.newId('markup', suppliedId), type: 'markup', markupType: text(type, 'type'), status: text(status, 'status'), page: number(page, 'page', { min: 1, positive: true }), properties: finiteRecord(properties, 'properties'), createdAt: this.now() }; return this.write(documentId, 'annotations', record, options.expectedRevision); }
  listMarkups(documentId, { type, status, page } = {}) { return this.records(documentId, 'annotations', 'markup').filter((item) => (!type || item.markupType === type) && (!status || item.status === status) && (!page || item.page === page)); }
  createCustomColumn(documentId, { id: suppliedId, name, formula }, options = {}) { const safeFormula = text(formula, 'formula', 500); evaluateFormula(safeFormula, {}, true); const record = { id: this.newId('column', suppliedId), type: 'custom-column', name: text(name, 'name'), formula: safeFormula, createdAt: this.now() }; return this.write(documentId, 'metadata', record, options.expectedRevision); }
  evaluateCustomColumn(documentId, columnId, values) { const column = this.get(documentId, 'metadata', id(columnId, 'columnId')); if (column.type !== 'custom-column') fail('INVALID_COLUMN', 'Record is not a custom column.'); return evaluateFormula(column.formula, finiteRecord(values, 'values')); }
  createSpace(documentId, { id: suppliedId, name, points: rawPoints, kind = 'space' }, options = {}) { const record = { id: this.newId('space', suppliedId), type: 'space-region', kind: text(kind, 'kind'), name: text(name, 'name'), points: points(rawPoints, 3), createdAt: this.now() }; return this.write(documentId, 'metadata', record, options.expectedRevision); }
  createDrawingSet(documentId, { id: suppliedId, name, sheets }, options = {}) { const record = { id: this.newId('drawing-set', suppliedId), type: 'drawing-set', name: text(name, 'name'), sheets: list(sheets, 'sheets', 100).map((sheet) => id(sheet, 'sheet id')), createdAt: this.now() }; return this.write(documentId, 'reviewRecords', record, options.expectedRevision); }
  createSheet(documentId, { id: suppliedId, number: sheetNumber, title, tags = [] }, options = {}) { const record = { id: this.newId('sheet', suppliedId), type: 'sheet', number: text(sheetNumber, 'number'), title: text(title, 'title'), tags: list(tags, 'tags', 50).map((tag) => text(tag, 'tag', 80)), createdAt: this.now() }; return this.write(documentId, 'reviewRecords', record, options.expectedRevision); }
  createRevisionOverlay(documentId, { id: suppliedId, fromDigest, toDigest, sheetId }, options = {}) { const record = { id: this.newId('overlay', suppliedId), type: 'revision-overlay', fromDigest: digest(fromDigest, 'fromDigest'), toDigest: digest(toDigest, 'toDigest'), sheetId: id(sheetId, 'sheetId'), createdAt: this.now() }; if (record.fromDigest === record.toDigest) fail('INVALID_REVISION_OVERLAY', 'Revision overlays must link two distinct digests.'); return this.write(documentId, 'reviewRecords', record, options.expectedRevision); }
  createBatchPlan(documentId, { id: suppliedId, kind, pairs }, options = {}) { if (!['slip-sheet', 'link'].includes(kind)) fail('INVALID_PLAN', 'Plan kind must be slip-sheet or link.'); const record = { id: this.newId('batch', suppliedId), type: 'batch-plan', kind, pairs: list(pairs, 'pairs', 100).map((pair) => ({ from: id(pair?.from, 'pair.from'), to: id(pair?.to, 'pair.to') })), createdAt: this.now() }; return this.write(documentId, 'workflowRecords', record, options.expectedRevision); }
  legends(documentId) { const result = {}; for (const markup of this.records(documentId, 'annotations', 'markup')) result[markup.markupType] = (result[markup.markupType] ?? 0) + 1; return result; }
  calibrateGeoPage(documentId, { id: suppliedId, page, origin, scale, rotation = 0 }, options = {}) { const record = { id: this.newId('geo', suppliedId), type: 'geo-calibration', page: number(page, 'page', { min: 1, positive: true }), origin: point(origin), scale: number(scale, 'scale', { positive: true, max: 100000 }), rotation: number(rotation, 'rotation', { min: -360, max: 360 }), createdAt: this.now() }; return this.write(documentId, 'metadata', record, options.expectedRevision); }
  pageToGeo(documentId, calibrationId, pagePoint) { const record = this.get(documentId, 'metadata', id(calibrationId, 'calibrationId')); if (record.type !== 'geo-calibration') fail('INVALID_CALIBRATION', 'Record is not a geospatial calibration.'); const value = point(pagePoint); const radians = record.rotation * Math.PI / 180; const x = value.x * record.scale; const y = value.y * record.scale; return { x: record.origin.x + x * Math.cos(radians) - y * Math.sin(radians), y: record.origin.y + x * Math.sin(radians) + y * Math.cos(radians) }; }
  takeoff(documentId, { id: suppliedId, measurementIds, group = 'default' }, options = {}) {
    const all = this.records(documentId, 'measurements', 'measurement');
    const measurements = list(measurementIds, 'measurementIds', 100).map((measurementId) => {
      const record = all.find((item) => item.id === id(measurementId, 'measurementId'));
      if (!record) fail('ENTITY_NOT_FOUND', 'Takeoff references a missing measurement.', 404);
      return record;
    });
    const quantities = {};
    for (const measurement of measurements) {
      const unit = measurement.result?.siUnit ?? measurement.unit;
      const quantity = measurement.result?.siValue ?? measurement.quantity;
      if (!Number.isFinite(quantity) || typeof unit !== 'string') fail('INVALID_MEASUREMENT', 'Takeoff requires numeric AEC measurements.');
      quantities[unit] = (quantities[unit] ?? 0) + quantity;
    }
    const record = { id: this.newId('takeoff', suppliedId), type: 'quantity-takeoff', group: text(group, 'group'), measurementIds: measurements.map((item) => item.id), quantities, createdAt: this.now() };
    return this.write(documentId, 'takeoffs', record, options.expectedRevision);
  }
}
