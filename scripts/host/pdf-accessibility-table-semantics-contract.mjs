import { isProxy } from 'node:util/types';

export const PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE = 'local-accessibility-table-semantics-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_CELLS = 400;
const MAX_DIMENSION = 100;
const MAX_HEADERS = 32;
const ROLES = new Set(['TH', 'TD']);
const SCOPES = new Set(['row', 'column', 'both']);

function invalid(message = 'The accessible table semantics request is invalid.') {
  const error = new Error(message); error.code = 'INVALID_PDF_ACCESSIBILITY_TABLE_SEMANTICS'; return error;
}
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid(`${label} must be a plain data object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value); const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || Object.values(descriptors).some((descriptor) => descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'))) throw invalid(`${label} has unsupported fields.`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function integer(value, label, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${label} is out of bounds.`); return value; }
function ascii(value, label, max) { if (typeof value !== 'string' || value.length < 1 || value.length > max || !/^[A-Za-z0-9._:-]+$/u.test(value)) throw invalid(`${label} is invalid.`); return value; }
function reference(value, label) { const item = exact(value, ['object', 'generation'], label); return Object.freeze({ object: integer(item.object, `${label}.object`, 1, 1_000_000), generation: integer(item.generation, `${label}.generation`, 0, 65_535) }); }
function dense(value, label, max) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid(`${label} must be a dense array.`);
  const descriptors = Object.getOwnPropertyDescriptors(value); const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max || Reflect.ownKeys(value).length !== length + 1) throw invalid(`${label} must be a dense array.`);
  for (let index = 0; index < length; index += 1) { const descriptor = descriptors[index]; if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw invalid(`${label} must be dense.`); }
  return Array.from({ length }, (_, index) => descriptors[index].value);
}

function normalizeCell(value) {
  const item = exact(value, ['id', 'structRef', 'role', 'row', 'column', 'page', 'contentRef', 'mcid', 'scope', 'headers', 'rowSpan', 'colSpan'], 'cell');
  if (!ROLES.has(item.role)) throw invalid('cell role must be TH or TD.');
  if (item.scope !== null && (!SCOPES.has(item.scope) || item.role !== 'TH')) throw invalid('scope is only allowed on TH cells.');
  const headers = dense(item.headers, 'headers', MAX_HEADERS).map((header) => ascii(header, 'header id', 96));
  return Object.freeze({
    id: ascii(item.id, 'cell id', 96), structRef: reference(item.structRef, 'cell.structRef'), role: item.role,
    row: integer(item.row, 'cell.row', 0, MAX_DIMENSION - 1), column: integer(item.column, 'cell.column', 0, MAX_DIMENSION - 1),
    page: integer(item.page, 'cell.page', 1, 10_000), contentRef: reference(item.contentRef, 'cell.contentRef'),
    mcid: integer(item.mcid, 'cell.mcid', 0, 10_000), scope: item.scope,
    headers: Object.freeze(headers), rowSpan: integer(item.rowSpan, 'cell.rowSpan', 1, MAX_DIMENSION), colSpan: integer(item.colSpan, 'cell.colSpan', 1, MAX_DIMENSION),
  });
}

function validateRectangle(cells) {
  const ids = new Set(); const refs = new Set(); const byId = new Map();
  for (const cell of cells) { if (ids.has(cell.id)) throw invalid('cell ids must be unique.'); ids.add(cell.id); const key = `${cell.structRef.object}:${cell.structRef.generation}`; if (refs.has(key)) throw invalid('cell StructElem references must be unique.'); refs.add(key); byId.set(cell.id, cell); }
  for (const cell of cells) for (const id of cell.headers) { const target = byId.get(id); if (!target || target.role !== 'TH') throw invalid('headers must reference TH cell ids.'); }
  const maxRow = Math.max(...cells.map((cell) => cell.row + cell.rowSpan)); const maxColumn = Math.max(...cells.map((cell) => cell.column + cell.colSpan));
  const occupied = new Set();
  for (const cell of cells) for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) for (let column = cell.column; column < cell.column + cell.colSpan; column += 1) { const key = `${row}:${column}`; if (occupied.has(key)) throw invalid('cell spans overlap.'); occupied.add(key); }
  if (occupied.size !== maxRow * maxColumn || [...occupied].some((key) => { const [row, column] = key.split(':').map(Number); return row < 0 || column < 0 || row >= maxRow || column >= maxColumn; })) throw invalid('cells must form a complete rectangle.');
  return Object.freeze({ ids, refs, byId, rows: maxRow, columns: maxColumn });
}

export function normalizePdfAccessibilityTableSemantics(value) {
  const request = exact(value, ['profile', 'sourceSha256', 'table'], 'table semantics request');
  const table = exact(request.table, ['tableRef', 'cells'], 'table');
  if (request.profile !== PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE || !SHA256.test(request.sourceSha256 ?? '')) throw invalid();
  const tableRef = reference(table.tableRef, 'table.tableRef'); const cells = dense(table.cells, 'table.cells', MAX_CELLS).map(normalizeCell);
  if (cells.length < 1) throw invalid('table.cells must not be empty.');
  const rectangle = validateRectangle(cells);
  return Object.freeze({ profile: PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE, sourceSha256: request.sourceSha256, table: Object.freeze({ tableRef, cells: Object.freeze(cells) }) });
}
export const ACCESSIBILITY_TABLE_SEMANTICS_LIMITS = Object.freeze({ maxCells: MAX_CELLS, maxDimension: MAX_DIMENSION, maxHeaders: MAX_HEADERS });
