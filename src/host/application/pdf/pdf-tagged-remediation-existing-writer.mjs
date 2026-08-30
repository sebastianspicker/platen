import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { resolvePdfPageTree } from './pdf-page-tree-resolver.mjs';
import { tokenizePdfContentStream } from './pdf-content-stream-tokenizer.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { TAGGED_PDF_REMEDIATION_PROFILE, normalizeTaggedPdfRemediationRequest } from './pdf-tagged-remediation-contract.mjs';

const HAZARD_KEYS = new Set(['A', 'AA', 'AcroForm', 'AF', 'Annots', 'ByteRange', 'Collection', 'Dests', 'EF', 'EmbeddedFiles', 'JS', 'Metadata', 'Names', 'OC', 'OCG', 'OCGs', 'OCProperties', 'OpenAction', 'Perms', 'PieceInfo', 'PresSteps', 'RichMediaContent', 'StructTreeRoot', 'StructParents', 'StructParent', 'ParentTree', 'XFA']);
const HAZARD_TYPES = new Set(['Action', 'Annot', 'EmbeddedFile', 'Filespec', 'OCG', 'OCMD', 'Sig', 'StructElem', 'StructTreeRoot', 'XRef', 'ObjStm']);
const HAZARD_SUBTYPES = new Set(['3D', 'FileAttachment', 'Movie', 'PS', 'Projection', 'RichMedia', 'Screen', 'Sound', 'XML']);
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'The PDF is outside the bounded tagged-PDF remediation subset.') { return failure('UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF', message); }
function invalidOutput() { return failure('INVALID_TAGGED_PDF_REMEDIATION_OUTPUT', 'Tagged-PDF remediation output proof failed.'); }
function ref(object, generation = 0) { return Object.freeze({ type: 'ref', object, generation }); }
function number(value) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw: String(value) }); }
function name(value) { return Object.freeze({ type: 'name', value }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function sameRef(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function changedId(sourceBytes, request) { return createHash('sha256').update('Platen tagged remediation ID v1\0').update(sourceBytes).update(JSON.stringify(request)).digest().subarray(0, 16); }

// Existing-structure mode is deliberately separate from the legacy candidate
// tree writer. It can only rename/reorder already linked StructElem nodes; it
// never invents MCIDs or rewrites source content streams.
function sourceBoundState(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes) || sha256(sourceBytes) !== request.sourceSha256) throw unsupported('The remediation plan is not bound to the source digest.');
  let structure;
  try { structure = parsePdfStructure(sourceBytes); } catch { throw unsupported('The source PDF structure is unsupported.'); }
  if (structure.revisions.length !== 1) throw unsupported('Existing-structure remediation rejects prior incremental revisions.');
  const catalog = pdfDictionary(resolvePdfObject(structure, structure.root).value);
  const structRootRef = catalog.get('StructTreeRoot');
  if (structRootRef?.type !== 'ref' || catalog.get('MarkInfo')?.type !== 'ref') throw unsupported('A complete existing tag tree and MarkInfo are required.');
  const markInfo = pdfDictionary(resolvePdfObject(structure, catalog.get('MarkInfo')).value);
  if (markInfo.get('Marked')?.type !== 'boolean' || markInfo.get('Marked').value !== true) throw unsupported('The existing document is not marked.');
  const treeStructure = structure.xrefFlavor === 'classic' ? parseClassicPdfStructure(sourceBytes) : structure;
  let tree;
  try { tree = resolvePdfPageTree({ structure: treeStructure, limits: { maxPages: 100 } }); } catch { throw unsupported('The page tree is malformed.'); }
  const pageByRef = new Map(tree.pages.map((page) => [`${page.reference.object}:${page.reference.generation}`, page]));
  const isStructuralKey = new Set(['Type', 'S', 'P', 'K', 'Pg', 'MCID', 'ParentTree', 'ParentTreeNextKey', 'RoleMap', 'MarkInfo', 'StructTreeRoot', 'StructParents']);
  const seenObjects = new Set(); const allStructElems = new Set();
  const structElems = new Map(); const mcidEntries = new Map(); const stack = new Set();
  const visitElem = (reference, parentReference, isRoot = false) => {
    const key = `${reference.object}:${reference.generation}`;
    if (stack.has(key)) throw unsupported('The existing structure tree contains a cycle.');
    if (structElems.has(key)) throw unsupported('The existing structure tree reuses a StructElem.');
    let object; try { object = resolvePdfObject(structure, reference); } catch { throw unsupported('A StructElem reference is missing.'); }
    if (object.stream) throw unsupported('StructElem objects must be non-stream dictionaries.');
    const entries = pdfDictionary(object.value); const type = entries.get('Type'); const role = entries.get('S');
    if (type?.type !== 'name' || type.value !== 'StructElem' || role?.type !== 'name') throw unsupported('The structure tree contains a malformed StructElem.');
    const declaredParent = entries.get('P');
    if (isRoot ? declaredParent?.type !== 'ref' || `${declaredParent.object}:${declaredParent.generation}` !== `${structRootRef.object}:${structRootRef.generation}` : declaredParent?.type !== 'ref' || `${declaredParent.object}:${declaredParent.generation}` !== `${parentReference.object}:${parentReference.generation}`) throw unsupported('StructElem parent links are inconsistent.');
    const kids = entries.get('K'); if (kids?.type !== 'array' || kids.values.length < 1) throw unsupported('StructElem children are missing.');
    stack.add(key); const children = []; let mcr = null;
    for (const child of kids.values) {
      if (child?.type === 'ref') { visitElem(child, reference); children.push(`${child.object}:${child.generation}`); continue; }
      if (child?.type !== 'dict' || child.entries.get('Type')?.type !== 'name' || child.entries.get('Type').value !== 'MCR') throw unsupported('The structure tree contains an unsupported child.');
      if (mcr) throw unsupported('Multiple MCIDs per StructElem are unsupported.');
      const pageRef = child.entries.get('Pg'); const mcid = child.entries.get('MCID');
      if (pageRef?.type !== 'ref' || mcid?.type !== 'number' || !mcid.integer || mcid.value < 0) throw unsupported('An MCR is missing a unique page or MCID.');
      const page = pageByRef.get(`${pageRef.object}:${pageRef.generation}`); if (!page) throw unsupported('An MCR targets a missing page.');
      const mcidKey = `${page.index + 1}:${mcid.value}`; if (mcidEntries.has(mcidKey)) throw unsupported('Duplicate MCIDs are unsupported.');
      mcr = Object.freeze({ page, pageRef, mcid: mcid.value, value: child }); mcidEntries.set(mcidKey, Object.freeze({ structRef: reference, elemRole: role.value, ...mcr }));
    }
    stack.delete(key); structElems.set(key, Object.freeze({ reference, role: role.value, parent: parentReference, children: Object.freeze(children), mcr }));
  };
  const rootEntries = pdfDictionary(resolvePdfObject(structure, structRootRef).value); const rootKids = rootEntries.get('K');
  if (rootKids?.type !== 'array' || rootKids.values.length !== 1 || rootKids.values[0]?.type !== 'ref') throw unsupported('The StructTreeRoot must have one Document child.');
  visitElem(rootKids.values[0], structRootRef, true);
  // Reject active content, annotations, forms, layers, and unsupported streams;
  // structural dictionaries are inspected above and are the only exception.
  const forbiddenStructureValue = (value) => {
    if (value?.type === 'array') return value.values.some(forbiddenStructureValue);
    if (value?.type !== 'dict') return false;
    if ([...value.entries.keys()].some((key) => !isStructuralKey.has(key) && HAZARD_KEYS.has(key))) return true;
    const type = value.entries.get('Type'); const subtype = value.entries.get('Subtype'); const field = value.entries.get('FT');
    if (type?.type === 'name' && HAZARD_TYPES.has(type.value) && !['StructElem', 'StructTreeRoot'].includes(type.value)) return true;
    if (subtype?.type === 'name' && HAZARD_SUBTYPES.has(subtype.value)) return true;
    if (field?.type === 'name' && field.value === 'Sig') return true;
    return [...value.entries.values()].some(forbiddenStructureValue);
  };
  visitPdfObjects(structure, (object) => { if (forbiddenStructureValue(object.value)) throw unsupported('The source contains active content, forms, signatures, or layers.'); seenObjects.add(`${object.reference.object}:${object.reference.generation}`); if (object.value?.type === 'dict' && object.value.entries.get('Type')?.type === 'name' && object.value.entries.get('Type').value === 'StructElem') allStructElems.add(`${object.reference.object}:${object.reference.generation}`); });
  if (allStructElems.size !== structElems.size) throw unsupported('The source contains unreachable structure elements.');
  const contentByRef = new Map();
  for (const page of tree.pages) {
    const pageEntries = pdfDictionary(page.page.value);
    if (pageEntries.has('Annots') || pageEntries.has('AA') || pageEntries.has('A') || pageEntries.has('OC')) throw unsupported('Annotations, actions, and layers are unsupported.');
    for (const content of page.contents) {
      const entries = content.stream.value.entries;
      if (entries.has('Filter') || entries.has('DecodeParms')) throw unsupported('Filtered content streams are ambiguous.');
      const length = entries.get('Length'); if (length?.type !== 'number' || !length.integer || length.value !== content.streamLength) throw unsupported('Content stream length is ambiguous.');
      try { tokenizePdfContentStream({ sourceBytes, stream: content.stream }); } catch { throw unsupported('Content stream syntax is unsupported.'); }
      contentByRef.set(`${content.reference.object}:${content.reference.generation}`, Object.freeze({ page, content }));
    }
  }
  for (const entry of mcidEntries.values()) {
    const streams = entry.page.contents.map((content) => sourceBytes.subarray(content.stream.streamStart, content.stream.streamStart + content.stream.streamLength).toString('latin1')).join('\n');
    const matches = [...streams.matchAll(/\/MCID\s+([0-9]+)\s*>>\s*BDC/gu)].filter((match) => Number(match[1]) === entry.mcid);
    if (matches.length !== 1) throw unsupported('Every planned MCID must map to one marked-content item.');
  }
  return Object.freeze({ structure, catalog, structRootRef, rootEntries, tree, structElems, mcidEntries, contentByRef });
}

function sourceBoundPlan(request, state) {
  const nodes = []; const byRef = new Map(); const visit = (node, parent = null) => {
    const key = `${node.structRef.object}:${node.structRef.generation}`;
    if (byRef.has(key)) throw unsupported('The remediation plan repeats a StructElem reference.');
    const existing = state.structElems.get(key); if (!existing) throw unsupported('The remediation plan references a missing StructElem.');
    if (node.role === 'Link' || ['Table', 'TR', 'TH', 'TD'].includes(node.role)) throw unsupported('Links, tables, and form semantics remain proposal-only.');
    if (existing.role === 'Document' && node.role !== 'Document') throw unsupported('The existing Document root role cannot be changed.');
    if (Boolean(node.children) !== Boolean(existing.children.length)) throw unsupported('The remediation plan cannot change a leaf into a container or vice versa.');
    if (parent && `${existing.parent.object}:${existing.parent.generation}` !== `${parent.structRef.object}:${parent.structRef.generation}`) throw unsupported('The remediation plan changes an unrelated parent.');
    const record = { node, existing, parent }; nodes.push(record); byRef.set(key, record);
    if (node.children) { for (const child of node.children) visit(child, node); }
    else {
      if (!existing.mcr || node.mcid !== existing.mcr.mcid || `${node.page}` !== `${existing.mcr.page.index + 1}`) throw unsupported('The remediation plan MCID does not match the existing structure.');
      const content = state.contentByRef.get(`${node.contentRef.object}:${node.contentRef.generation}`); if (!content || content.page.index !== existing.mcr.page.index) throw unsupported('The remediation plan content reference is missing or ambiguous.');
    }
  };
  visit(request.plan);
  if (nodes.length !== state.structElems.size || [...state.structElems.keys()].some((key) => !byRef.has(key))) throw unsupported('The fixed remediation plan must account for the complete existing tag tree.');
  return Object.freeze({ nodes: Object.freeze(nodes), byRef });
}

function appendSourceBound(sourceBytes, request, state, plan) {
  const updates = [];
  for (const { node, existing } of plan.nodes) {
    const object = resolvePdfObject(state.structure, existing.reference); const entries = new Map(pdfDictionary(object.value));
    entries.set('S', name(node.role));
    if (node.children) entries.set('K', array(node.children.map((child) => ref(child.structRef.object, child.structRef.generation))));
    updates.push({ reference: existing.reference, value: dict(entries) });
  }
  const root = new Map(state.rootEntries); root.set('K', array([ref(request.plan.structRef.object, request.plan.structRef.generation)]));
  if (Object.keys(request.roleMap).length) {
    const current = state.rootEntries.get('RoleMap'); const existing = current?.type === 'dict' ? new Map(current.entries) : new Map();
    for (const [role, target] of Object.entries(request.roleMap)) {
      const previous = existing.get(role); if (previous && (previous.type !== 'name' || previous.value !== target)) throw unsupported('RoleMap changes are not source-safe.');
      existing.set(role, name(target));
    }
    root.set('RoleMap', dict(existing));
  }
  updates.push({ reference: state.structRootRef, value: dict(root) });
  const transaction = planPdfObjectTransaction({ sourceBytes, sourceStructure: state.structure, updates, additions: [], info: { kind: 'preserve' }, changingId: state.structure.id ? changedId(sourceBytes, request) : null });
  return Object.freeze({ bytes: Buffer.concat([sourceBytes, transaction.revision.bytes]), transaction, plan, state });
}

function sourceBoundProof(sourceBytes, outputBytes, state, built, request) {
  let output; try { output = parsePdfStructure(outputBytes); } catch { throw invalidOutput(); }
  if (!outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
  try {
    const outputTreeStructure = output.xrefFlavor === 'classic' ? parseClassicPdfStructure(outputBytes) : output;
    const outputTree = resolvePdfPageTree({ structure: outputTreeStructure, limits: { maxPages: 100 } });
    if (outputTree.pageCount !== state.tree.pageCount || outputTree.pages.some((page, index) => (
      page.rotate !== state.tree.pages[index].rotate
      || page.mediaBox.some((value, boxIndex) => value !== state.tree.pages[index].mediaBox[boxIndex])
      || page.cropBox.some((value, boxIndex) => value !== state.tree.pages[index].cropBox[boxIndex])
    ))) throw invalidOutput();
    const catalog = pdfDictionary(resolvePdfObject(output, output.root).value);
    const structRoot = catalog.get('StructTreeRoot'); if (structRoot?.type !== 'ref' || !sameRef(structRoot, state.structRootRef)) throw invalidOutput();
    for (const { node, existing } of built.plan.nodes) {
      const elem = pdfDictionary(resolvePdfObject(output, existing.reference).value);
      if (elem.get('S')?.type !== 'name' || elem.get('S').value !== node.role) throw invalidOutput();
      if (node.children) {
        const kids = elem.get('K'); if (kids?.type !== 'array' || kids.values.length !== node.children.length || kids.values.some((value, index) => !sameRef(value, node.children[index].structRef))) throw invalidOutput();
      }
    }
    for (const page of state.tree.pages) for (const content of page.contents) {
      const original = resolvePdfObject(output, content.reference);
      const sourceBytesForStream = sourceBytes.subarray(content.stream.streamStart, content.stream.streamStart + content.stream.streamLength);
      if (!original.stream || !output.buffer.subarray(original.streamStart, original.streamStart + original.streamLength).equals(sourceBytesForStream)) throw invalidOutput();
    }
  } catch (error) { if (error?.code === 'INVALID_TAGGED_PDF_REMEDIATION_OUTPUT') throw error; throw invalidOutput(); }
  const originals = [];
  for (const page of state.tree.pages) for (const content of page.contents) originals.push({ page: page.index + 1, contentIndex: page.contents.indexOf(content), sha256: sha256(sourceBytes.subarray(content.stream.streamStart, content.stream.streamStart + content.stream.streamLength)), bytes: content.streamLength });
  return Object.freeze({ profile: TAGGED_PDF_REMEDIATION_PROFILE, sourceSha256: sha256(sourceBytes), outputSha256: sha256(outputBytes), sourcePrefixPreserved: true, originalContentStreamsUnchanged: true, deterministic: true, pageCount: state.tree.pageCount, pageGeometry: state.tree.pages.map((page) => Object.freeze({ mediaBox: [...page.mediaBox], cropBox: [...page.cropBox], rotate: page.rotate })), structureLinked: true, tagTreeReinspected: true, textEvidence: 'content-streams-unchanged', renderingEvidence: 'page-geometry-and-content-preserved', structTreeRootObjectNumber: state.structRootRef.object, appendedBytes: built.bytes.length - sourceBytes.length, revisionCount: output.revisions.length, originalContentStreams: Object.freeze(originals) });
}

export function writeExistingTaggedPdfRemediation(sourceBytes, requestValue) {
  const request = normalizeTaggedPdfRemediationRequest(requestValue);
  if (request.plan.mode !== 'existing-structure-v1') throw new TypeError('Existing-structure remediation requires mode existing-structure-v1.');
  const state = sourceBoundState(sourceBytes, request); const plan = sourceBoundPlan(request, state); const built = appendSourceBound(sourceBytes, request, state, plan);
  return Object.freeze({ bytes: built.bytes, proof: sourceBoundProof(sourceBytes, built.bytes, state, built, request) });
}
