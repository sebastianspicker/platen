import { createHash } from 'node:crypto';
import { pdfDictionary, serializePdfValue } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { tokenizePdfContentStream } from './pdf-content-stream-tokenizer.mjs';
import { normalizePdfAccessibilityTableSemantics, PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE } from './pdf-accessibility-table-semantics-contract.mjs';

const HAZARD_KEYS = new Set(['A', 'AA', 'AcroForm', 'AF', 'Annots', 'ByteRange', 'Collection', 'Dests', 'EF', 'EmbeddedFiles', 'Encrypt', 'JS', 'Metadata', 'Names', 'OC', 'OCG', 'OCGs', 'OCProperties', 'OpenAction', 'Perms', 'PieceInfo', 'PresSteps', 'RichMediaContent', 'Sound', 'Movie', 'XFA']);
const HAZARD_TYPES = new Set(['Action', 'Annot', 'EmbeddedFile', 'Filespec', 'OCG', 'OCMD', 'Sig', 'ObjStm', 'XRef']);
const HAZARD_SUBTYPES = new Set(['3D', 'FileAttachment', 'Movie', 'PS', 'Projection', 'RichMedia', 'Screen', 'Sound', 'XML']);
const SAFE_STRUCT_KEYS = new Set(['Type', 'S', 'P', 'K', 'Pg', 'MCID', 'ParentTree', 'ParentTreeNextKey', 'RoleMap', 'MarkInfo', 'Marked', 'StructTreeRoot', 'StructParents']);
const ACTIONS = new Set(['JavaScript', 'URI', 'Launch', 'GoTo', 'SubmitForm', 'ResetForm', 'ImportData', 'Named']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'The source is outside the bounded table-semantics subset.') { throw failure('UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS', message); }
function invalidOutput(message = 'Table semantics output proof failed.') { throw failure('INVALID_PDF_ACCESSIBILITY_TABLE_SEMANTICS_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function ref(value) { if (value?.type !== 'ref') unsupported('Indirect references are required.'); return Object.freeze({ type: 'ref', object: value.object, generation: value.generation }); }
function sameRef(a, b) { return a?.object === b?.object && a?.generation === b?.generation; }
function name(value) { return Object.freeze({ type: 'name', value }); }
function number(value) { return Object.freeze({ type: 'number', value, integer: true, raw: String(value) }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function dimensions(cells) { return Object.freeze({ rows: Math.max(...cells.map((cell) => cell.row + cell.rowSpan)), columns: Math.max(...cells.map((cell) => cell.column + cell.colSpan)) }); }
function direct(structure, reference, label) { const object = resolveClassicPdfObject(structure, reference); if (object.stream || object.value?.type !== 'dict') unsupported(`${label} must be a direct dictionary.`); return pdfDictionary(object.value); }

function markedContentInventory(tokenized) {
  const counts = new Map(); let containerDepth = 0; let markedDepth = 0;
  for (let index = 0; index < tokenized.tokens.length; index += 1) {
    const token = tokenized.tokens[index];
    if (token.type === 'array-start' || token.type === 'dict-start') { containerDepth += 1; continue; }
    if (token.type === 'array-end' || token.type === 'dict-end') { containerDepth -= 1; if (containerDepth < 0) unsupported('Content container operators are malformed.'); continue; }
    if (token.type !== 'operator') continue;
    if (token.value === 'BMC') unsupported('Unscoped marked content is not admitted.');
    if (token.value === 'EMC') { if (containerDepth !== 0 || markedDepth !== 1) unsupported('Marked-content operators are unbalanced.'); markedDepth = 0; continue; }
    if (token.value !== 'BDC') continue;
    const operands = tokenized.tokens.slice(index - 5, index);
    if (containerDepth !== 0 || markedDepth !== 0 || operands.length !== 5
      || operands[0]?.type !== 'name' || operands[0].value !== 'P'
      || operands[1]?.type !== 'dict-start' || operands[2]?.type !== 'name' || operands[2].value !== 'MCID'
      || operands[3]?.type !== 'number' || !operands[3].integer || operands[3].value < 0
      || operands[4]?.type !== 'dict-end') unsupported('Only exact /P << /MCID n >> BDC operators are admitted.');
    const mcid = operands[3].value; if (counts.has(mcid)) unsupported('Duplicate marked-content MCIDs are not admitted.'); counts.set(mcid, 1); markedDepth = 1;
  }
  if (containerDepth !== 0 || markedDepth !== 0) unsupported('Marked-content operators are unbalanced.');
  return counts;
}

function inspectHazards(value, seen, structure, structural = false) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'ref') {
    const key = `${value.object}:${value.generation}`; if (seen.has(key)) return; seen.add(key);
    const object = resolveClassicPdfObject(structure, value); if (!object.stream) inspectHazards(object.value, seen, structure, structural); return;
  }
  if (value.type === 'array') { for (const child of value.values) inspectHazards(child, seen, structure, structural); return; }
  if (value.type !== 'dict') return;
  const type = value.entries.get('Type'); const isStruct = structural || (type?.type === 'name' && ['StructElem', 'StructTreeRoot'].includes(type.value));
  for (const [key, child] of value.entries) {
    if (key === 'A') {
      if (!isStruct || child?.type !== 'dict' || child.entries.get('O')?.type !== 'name' || child.entries.get('O').value !== 'Table') unsupported('Only Table attribute dictionaries are admitted.');
      inspectHazards(child, seen, structure, true); continue;
    }
    if (HAZARD_KEYS.has(key) && !(isStruct && SAFE_STRUCT_KEYS.has(key))) unsupported('Active content, forms, attachments, scripts, signatures, or layers are not admitted.');
    if (key === 'FT' && child?.type === 'name' && child.value === 'Sig') unsupported('Signatures are not admitted.');
    inspectHazards(child, seen, structure, isStruct);
  }
  const action = value.entries.get('S'); if (action?.type === 'name' && ACTIONS.has(action.value)) unsupported('Actions are not admitted.');
  const subtype = value.entries.get('Subtype');
  if (type?.type === 'name' && HAZARD_TYPES.has(type.value)) unsupported('Unsupported active object type.');
  if (subtype?.type === 'name' && HAZARD_SUBTYPES.has(subtype.value)) unsupported('Unsupported annotation or media subtype.');
}

function pageInventory(structure, pagesRef) {
  const pages = []; const walk = (reference, inheritedParent = null) => {
    const entries = direct(structure, reference, 'page tree node'); const type = entries.get('Type')?.value;
    if (type === 'Page') {
      if (inheritedParent && !sameRef(entries.get('Parent'), inheritedParent)) unsupported('Page parent links are inconsistent.');
      const contents = entries.get('Contents'); if (!contents || (contents.type !== 'ref' && contents.type !== 'array')) unsupported('Every page needs direct content references.');
      const refs = contents.type === 'ref' ? [contents] : contents.values; if (!refs.length || refs.some((item) => item?.type !== 'ref')) unsupported('Page content references are malformed.');
      pages.push(Object.freeze({ reference, entries, contents: Object.freeze(refs.map(ref)) })); return;
    }
    if (type !== 'Pages' || entries.get('Kids')?.type !== 'array' || entries.get('Kids').values.length < 1 || entries.get('Kids').values.length > 10_000) unsupported('The page tree is unsupported.');
    for (const child of entries.get('Kids').values) walk(ref(child), reference);
  };
  walk(pagesRef); return Object.freeze(pages);
}

function sourceState(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 32 || sourceBytes.length > 32 * 1024 * 1024 || sourceBytes.includes(Buffer.from('/Encrypt', 'latin1'))) unsupported('Only bounded unencrypted classic PDFs are admitted.');
  if (digest(sourceBytes) !== request.sourceSha256) unsupported('The request is not bound to the source digest.');
  let structure; try { structure = parseClassicPdfStructure(sourceBytes); } catch { unsupported('Only valid classic-xref PDFs are admitted.'); }
  if (structure.revisions.length !== 1) unsupported('Only one unsigned source revision is admitted.');
  const catalog = direct(structure, structure.root, 'catalog'); if (catalog.get('Type')?.value !== 'Catalog' || catalog.get('Pages')?.type !== 'ref' || catalog.get('StructTreeRoot')?.type !== 'ref') unsupported('A catalog, page tree, and existing tag tree are required.');
  if (catalog.get('MarkInfo')?.type !== 'ref') unsupported('Marked-PDF evidence is required.');
  const mark = direct(structure, ref(catalog.get('MarkInfo')), 'MarkInfo'); if (mark.get('Marked')?.type !== 'boolean' || mark.get('Marked').value !== true) unsupported('The source must be marked.');
  const pages = pageInventory(structure, ref(catalog.get('Pages'))); const pageByRef = new Map(pages.map((page, index) => [`${page.reference.object}:${page.reference.generation}`, { ...page, index: index + 1 }]));
  const contentByRef = new Map(); for (const page of pages) { if (page.contents.length !== 1) unsupported('Every admitted table page must have exactly one content stream.'); for (const contentRef of page.contents) { const content = resolveClassicPdfObject(structure, contentRef); if (!content.stream) unsupported('Page content must be a stream.'); let tokenized; try { tokenized = tokenizePdfContentStream({ sourceBytes, stream: content }); } catch { unsupported('Page content syntax is malformed or unsupported.'); } const mcids = markedContentInventory(tokenized); contentByRef.set(`${contentRef.object}:${contentRef.generation}`, Object.freeze({ page, pageInfo: pageByRef.get(`${page.reference.object}:${page.reference.generation}`), content, mcids })); } }
  inspectHazards(catalog.get('StructTreeRoot'), new Set(), structure); for (const entry of structure.effective.values()) if (entry.status === 'n') { const object = resolveClassicPdfObject(structure, ref({ type: 'ref', object: entry.object, generation: entry.generation })); if (object.stream) continue; inspectHazards(object.value, new Set(), structure); }
  const structRootRef = ref(catalog.get('StructTreeRoot')); const root = direct(structure, structRootRef, 'StructTreeRoot'); const rootKids = root.get('K'); if (rootKids?.type !== 'array' || rootKids.values.length !== 1 || rootKids.values[0]?.type !== 'ref') unsupported('The tag root must contain exactly one table.');
  const structs = new Map(); const stack = new Set();
  const visit = (reference, parent, expectedRole) => {
    const key = `${reference.object}:${reference.generation}`; if (stack.has(key) || structs.has(key)) unsupported('The structure graph is cyclic, aliased, or duplicated.'); stack.add(key);
    const entries = direct(structure, reference, 'StructElem'); if (entries.get('Type')?.value !== 'StructElem' || entries.get('S')?.type !== 'name' || (expectedRole && entries.get('S').value !== expectedRole)) unsupported('The structure role graph is malformed.');
    const role = entries.get('S').value; if (entries.get('P')?.type !== 'ref' || !sameRef(entries.get('P'), parent)) unsupported('Structure parent links are inconsistent.');
    const kids = entries.get('K'); if (kids?.type !== 'array' || kids.values.length < 1) unsupported('StructElem children are malformed.');
    const node = { reference, entries, role, parent, children: [] }; structs.set(key, node);
    if (role === 'Table') { if (kids.values.some((child) => child?.type !== 'ref')) unsupported('Table children must be TR references.'); for (const child of kids.values) { const childRef = ref(child); visit(childRef, reference, 'TR'); node.children.push(childRef); } }
    else if (role === 'TR') { if (kids.values.some((child) => child?.type !== 'ref')) unsupported('TR children must be cell references.'); for (const child of kids.values) { const childRef = ref(child); visit(childRef, reference, null); node.children.push(childRef); } }
    else if (role === 'TH' || role === 'TD') {
      if (kids.values.length !== 1 || kids.values[0]?.type !== 'dict' || kids.values[0].entries.get('Type')?.value !== 'MCR') unsupported('Each cell must contain one direct MCR.');
      const mcr = kids.values[0].entries; if (mcr.get('Pg')?.type !== 'ref' || mcr.get('MCID')?.type !== 'number' || !mcr.get('MCID').integer || !pageByRef.has(`${mcr.get('Pg').object}:${mcr.get('Pg').generation}`)) unsupported('Cell content binding is malformed.');
      const pageInfo = pageByRef.get(`${mcr.get('Pg').object}:${mcr.get('Pg').generation}`); const stream = pageInfo?.contents?.[0]; const streamObject = stream && contentByRef.get(`${stream.object}:${stream.generation}`);
      if (!streamObject) unsupported('Cell page content binding is missing.');
      if (streamObject.mcids.get(mcr.get('MCID').value) !== 1) unsupported('Every cell MCID must map to exactly one tokenized marked-content item.');
      node.mcr = Object.freeze({ page: pageInfo, pageRef: ref(mcr.get('Pg')), contentRef: ref(stream), mcid: mcr.get('MCID').value });
    } else unsupported('Only Table, TR, TH, and TD roles are admitted.');
    stack.delete(key);
  };
  const tableRef = ref(rootKids.values[0]); visit(tableRef, structRootRef, 'Table');
  const table = structs.get(`${tableRef.object}:${tableRef.generation}`); if (!table || !table.children.length) unsupported('The table has no rows.');
  const allStructElems = new Set(); for (const entry of structure.effective.values()) if (entry.status === 'n') { const object = resolveClassicPdfObject(structure, ref({ type: 'ref', object: entry.object, generation: entry.generation })); if (!object.stream && object.value?.type === 'dict' && object.value.entries.get('Type')?.type === 'name' && object.value.entries.get('Type').value === 'StructElem') allStructElems.add(`${entry.object}:${entry.generation}`); }
  if (allStructElems.size !== structs.size) unsupported('Unreachable or duplicate StructElem objects are not admitted.');
  const cells = [...structs.values()].filter((node) => node.role === 'TH' || node.role === 'TD'); if (!cells.length || table.children.some((rowRef) => !structs.get(`${rowRef.object}:${rowRef.generation}`)?.children?.length)) unsupported('The table has no cells.');
  const mcids = new Set(); for (const cell of cells) { const key = `${cell.mcr.pageRef.object}:${cell.mcr.pageRef.generation}:${cell.mcr.mcid}`; if (mcids.has(key)) unsupported('Cell MCIDs must be unique per page.'); mcids.add(key); }
  return Object.freeze({ structure, catalog, structRootRef, tableRef, table, structs, cells: Object.freeze(cells), pages: Object.freeze(pages), pageByRef, contentByRef });
}

function build(sourceBytes, request, state) {
  if (!sameRef(request.table.tableRef, state.tableRef)) unsupported('tableRef does not identify the existing Table.');
  const rectangle = dimensions(request.table.cells); if (state.table.children.length !== rectangle.rows) unsupported('The request row model must match the existing TR inventory.');
  const planned = new Map(); const updates = [];
  const byRow = new Map(Array.from({ length: state.table.children.length }, (_, index) => [index, []]));
  for (const cell of request.table.cells) {
    const key = `${cell.structRef.object}:${cell.structRef.generation}`; if (planned.has(key)) unsupported('Cell references must be unique.');
    const node = state.structs.get(key); if (!node || node.role !== cell.role || !node.mcr) unsupported('A cell locator is not a member of this table.');
    const stream = state.contentByRef.get(`${cell.contentRef.object}:${cell.contentRef.generation}`); if (!stream || stream.pageInfo.index !== cell.page || !sameRef(node.mcr.pageRef, stream.page.reference) || node.mcr.mcid !== cell.mcid) unsupported('Cell content binding does not match the source.');
    const rowIndex = state.table.children.findIndex((rowRef) => sameRef(rowRef, node.parent)); if (rowIndex !== cell.row) unsupported('A cell row does not match its existing TR membership.'); byRow.get(rowIndex).push(cell);
    planned.set(key, cell);
  }
  if (planned.size !== state.cells.length || state.cells.some((node) => !planned.has(`${node.reference.object}:${node.reference.generation}`))) unsupported('The plan must account for every existing table cell.');
  for (let row = 0; row < state.table.children.length; row += 1) {
    const directCells = byRow.get(row).sort((left, right) => left.column - right.column); const inherited = new Set(); for (const candidate of request.table.cells) if (candidate.row < row && candidate.row + candidate.rowSpan > row) for (let column = candidate.column; column < candidate.column + candidate.colSpan; column += 1) inherited.add(column);
    let cursor = 0; while (inherited.has(cursor)) cursor += 1; for (const cell of directCells) { if (cell.column !== cursor) unsupported('Cell columns must preserve ordered TR coverage.'); for (let column = cell.column; column < cell.column + cell.colSpan; column += 1) { if (inherited.has(column)) unsupported('Cell spans overlap an existing row span.'); } cursor = cell.column + cell.colSpan; while (inherited.has(cursor)) cursor += 1; }
    if (cursor !== rectangle.columns) unsupported('Cell columns must cover each TR exactly.');
  }
  for (const cell of request.table.cells) {
    const node = state.structs.get(`${cell.structRef.object}:${cell.structRef.generation}`); const entries = new Map(node.entries);
    if (cell.role === 'TH') entries.set('ID', pdfUtf16BeString(cell.id));
    const attrs = entries.get('A'); if (attrs?.type === 'ref') unsupported('Referenced cell attribute dictionaries are ambiguous.');
    const attrEntries = attrs?.type === 'dict' ? new Map(attrs.entries) : new Map(); attrEntries.set('O', name('Table')); if (cell.scope) attrEntries.set('Scope', name(cell.scope === 'column' ? 'Column' : cell.scope === 'row' ? 'Row' : 'Both')); else attrEntries.delete('Scope'); if (cell.headers.length) attrEntries.set('Headers', array(cell.headers.map((id) => pdfUtf16BeString(id)))); else attrEntries.delete('Headers'); attrEntries.set('RowSpan', number(cell.rowSpan)); attrEntries.set('ColSpan', number(cell.colSpan)); entries.set('A', dict(attrEntries));
    updates.push({ reference: node.reference, value: dict(entries) });
  }
  const transaction = planClassicObjectTransaction({ sourceBytes, sourceStructure: state.structure, updates, additions: [], info: { kind: 'preserve' }, changingId: null });
  return Object.freeze({ bytes: Buffer.concat([sourceBytes, transaction.revision.bytes]), updates, planned });
}

function proof(sourceBytes, outputBytes, request, state, built) {
  if (!outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) invalidOutput('The source prefix changed.');
  let parsed; try { parsed = parseClassicPdfStructure(outputBytes); } catch { invalidOutput('The output is not a valid classic PDF.'); }
  if (parsed.revisions.length !== 2) invalidOutput('Exactly one append-only revision is required.');
  for (const node of state.cells) {
    const key = `${node.reference.object}:${node.reference.generation}`; const cell = built.planned.get(key); const after = pdfDictionary(resolveClassicPdfObject(parsed, node.reference).value);
    if (after.get('Type')?.value !== 'StructElem' || after.get('S')?.value !== cell.role) invalidOutput('A cell role changed.');
    if (cell.role === 'TH' && after.get('ID')?.type !== 'string' || cell.role === 'TH' && !after.get('ID').bytes.equals(pdfUtf16BeString(cell.id).bytes)) invalidOutput('A header ID changed.');
    const attrs = after.get('A'); if (attrs?.type !== 'dict' || attrs.entries.get('O')?.value !== 'Table' || attrs.entries.get('RowSpan')?.value !== cell.rowSpan || attrs.entries.get('ColSpan')?.value !== cell.colSpan) invalidOutput('A cell table attributes changed.');
    const scope = attrs.entries.get('Scope')?.value ?? null; const expectedScope = cell.scope === null ? null : cell.scope === 'column' ? 'Column' : cell.scope === 'row' ? 'Row' : 'Both'; if (scope !== expectedScope) invalidOutput('A cell scope changed.');
    const headerValues = attrs.entries.get('Headers'); if (cell.headers.length) { if (headerValues?.type !== 'array' || headerValues.values.length !== cell.headers.length || headerValues.values.some((item, index) => item?.type !== 'string' || !item.bytes.equals(pdfUtf16BeString(cell.headers[index]).bytes))) invalidOutput('A cell header association changed.'); } else if (headerValues) invalidOutput('Unexpected cell header associations.');
  }
  for (const entry of state.structure.effective.values()) {
    if (entry.status !== 'n') continue; const key = `${entry.object}:${entry.generation}`; if (state.cells.some((node) => `${node.reference.object}:${node.reference.generation}` === key)) continue;
    const before = resolveClassicPdfObject(state.structure, ref({ type: 'ref', object: entry.object, generation: entry.generation })); const after = resolveClassicPdfObject(parsed, ref({ type: 'ref', object: entry.object, generation: entry.generation })); if (serializePdfValue(before.value) !== serializePdfValue(after.value)) invalidOutput('An unrelated object changed.');
  }
  const rectangle = dimensions(request.table.cells); return Object.freeze({ profile: PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE, sourceSha256: digest(sourceBytes), sourcePrefixPreserved: true, tableRef: Object.freeze({ object: state.tableRef.object, generation: state.tableRef.generation }), rowCount: rectangle.rows, columnCount: rectangle.columns, cellCount: state.cells.length, structureLinked: true, contentStreamsUnchanged: true, deterministic: true, revisionCount: 2, changedObjectCount: built.updates.length });
}

export function writePdfAccessibilityTableSemantics(sourceBytes, requestValue) { const request = normalizePdfAccessibilityTableSemantics(requestValue); const state = sourceState(sourceBytes, request); const built = build(sourceBytes, request, state); return Object.freeze({ bytes: built.bytes, proof: proof(sourceBytes, built.bytes, request, state, built) }); }
export function inspectPdfAccessibilityTableSemantics(sourceBytes, outputBytes, requestValue) { const request = normalizePdfAccessibilityTableSemantics(requestValue); const state = sourceState(sourceBytes, request); const expected = build(sourceBytes, request, state); if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(expected.bytes)) invalidOutput(); return proof(sourceBytes, outputBytes, request, state, expected); }
export function inspectPdfAccessibilityTableSemanticsSource(sourceBytes, sourceSha256 = digest(sourceBytes)) {
  const state = sourceState(sourceBytes, { profile: PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE, sourceSha256 });
  const cells = state.cells.map((node) => {
    const row = state.table.children.findIndex((reference) => sameRef(reference, node.parent));
    const column = state.structs.get(`${node.parent.object}:${node.parent.generation}`).children
      .findIndex((reference) => sameRef(reference, node.reference));
    return Object.freeze({
      structRef: Object.freeze({ object: node.reference.object, generation: node.reference.generation }), role: node.role,
      row, column, page: node.mcr.page.index,
      contentRef: Object.freeze({ object: node.mcr.contentRef.object, generation: node.mcr.contentRef.generation }), mcid: node.mcr.mcid,
      locator: `table ${state.tableRef.object}:${state.tableRef.generation}, row ${row + 1}, column ${column + 1}`,
    });
  });
  return Object.freeze({
    profile: PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE, sourceSha256,
    table: Object.freeze({ tableRef: Object.freeze({ object: state.tableRef.object, generation: state.tableRef.generation }), cells: Object.freeze(cells) }),
  });
}
export const preparePdfAccessibilityTableSemantics = writePdfAccessibilityTableSemantics;
export const verifyPdfAccessibilityTableSemantics = inspectPdfAccessibilityTableSemantics;
