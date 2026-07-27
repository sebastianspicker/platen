import { createHash } from 'node:crypto';
import { pdfDictionary, pdfInteger, pdfReference, serializePdfValue } from './pdf-classic-syntax.mjs';
import { parsePdfStructure, parseClassicPdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { authorizePdfObjectDeletion, pendingPdfObjectReference, planPdfObjectDeletionTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfDeletionIncrementalRevision } from './pdf-incremental-deletion-revision.mjs';
import { buildPdfCompactRewrite, verifyPdfCompactRewrite } from './pdf-compact-rewrite.mjs';
import { ANNOTATION_FLATTEN_PROFILE, normalizeAnnotationFlatten } from './pdf-annotation-flatten-contract.mjs';

function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported() { return fail('UNSUPPORTED_ANNOTATION_FLATTEN_PDF', 'PDF is outside the supported square-annotation flatten subset.'); }
function invalidOutput() { return fail('INVALID_ANNOTATION_FLATTEN_OUTPUT', 'Square-annotation flatten output proof failed.'); }
const same = (a, b) => a.object === b.object && a.generation === b.generation;
const ref = (v) => pdfReference(v);
const name = (value) => Object.freeze({ type: 'name', value });
const num = (value) => Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw: String(value) });
const dict = (entries) => Object.freeze({ type: 'dict', entries: new Map(entries) });
const array = (values) => Object.freeze({ type: 'array', values: Object.freeze(values) });
const sourceHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const PAGE_KEYS = new Set(['Type', 'Parent', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Resources', 'Contents', 'Annots', 'Rotate']);
const PAGE_TREE_KEYS = new Set(['Type', 'Parent', 'Count', 'Kids', 'MediaBox', 'CropBox', 'Resources', 'Rotate']);
const ANNOTATION_KEYS = new Set(['Type', 'Subtype', 'F', 'Rect', 'AP', 'P', 'C', 'IC', 'CA', 'BS', 'Border', 'RD', 'BE', 'Contents', 'NM', 'M', 'CreationDate']);
const FORM_KEYS = new Set(['Type', 'Subtype', 'BBox', 'Matrix', 'Resources', 'Length']);
function checkedSource(value) { if (!Buffer.isBuffer(value) || value.length < 5 || value.length > MAX_SOURCE_BYTES || (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer)) throw unsupported(); return value; }
function onlyKeys(entries, allowed) { if ([...entries.keys()].some((key) => !allowed.has(key))) throw unsupported(); }
function directNumbers(value, count, nondegenerate = false) { if (value?.type !== 'array' || value.values.length !== count || value.values.some((v) => v?.type !== 'number' || !Number.isFinite(v.value))) throw unsupported(); const values = value.values.map((v) => v.value); if (nondegenerate && (values[0] >= values[2] || values[1] >= values[3])) throw unsupported(); return values; }
function formContent(bytes) {
  if (bytes.length < 1 || bytes.length > 4096) throw unsupported();
  const text = bytes.toString('latin1').trim();
  const arity = new Map([
    ['q', 0], ['Q', 0], ['w', 1], ['J', 1], ['j', 1], ['M', 1],
    ['m', 2], ['l', 2], ['c', 6], ['v', 4], ['y', 4], ['h', 0], ['re', 4],
    ['S', 0], ['s', 0], ['f', 0], ['F', 0], ['f*', 0], ['B', 0], ['B*', 0], ['b', 0], ['b*', 0], ['n', 0],
    ['W', 0], ['W*', 0], ['G', 1], ['g', 1], ['RG', 3], ['rg', 3], ['K', 4], ['k', 4],
  ]);
  const paint = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
  let depth = 0; let operands = 0; let painted = false;
  for (const token of text.split(/\s+/u)) {
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(token)) {
      const value = Number(token); if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw unsupported(); operands += 1; continue;
    }
    if (!arity.has(token) || operands !== arity.get(token)) throw unsupported();
    operands = 0;
    if (token === 'q') depth += 1;
    if (token === 'Q') depth -= 1;
    if (depth < 0 || depth > 8) throw unsupported();
    if (paint.has(token)) painted = true;
  }
  if (operands || depth || !painted) throw unsupported();
}
function pages(structure) {
  const catalog = pdfDictionary(resolvePdfObject(structure, structure.root).value);
  onlyKeys(catalog, new Set(['Type', 'Pages']));
  if (catalog.get('Type')?.value !== 'Catalog') throw unsupported();
  const seen = new Set();
  const result = [];
  function visit(reference, parent, depth) {
    if (depth > 16 || seen.size >= 256) throw unsupported();
    const key = `${reference.object}:${reference.generation}`;
    if (seen.has(key)) throw unsupported();
    seen.add(key);
    const object = resolvePdfObject(structure, reference);
    if (object.stream || object.compressed) throw unsupported();
    const entries = pdfDictionary(object.value);
    const type = entries.get('Type')?.value;
    if (!['Page', 'Pages'].includes(type)
      || (parent && !same(ref(entries.get('Parent')), parent))
      || (!parent && entries.has('Parent'))) throw unsupported();
    if (type === 'Page') {
      onlyKeys(entries, PAGE_KEYS);
      if ((entries.get('Rotate') && pdfInteger(entries.get('Rotate')) !== 0)
        || entries.has('UserUnit')) throw unsupported();
      result.push({ reference, entries });
      if (result.length > 100) throw unsupported();
      return 1;
    }
    onlyKeys(entries, PAGE_TREE_KEYS);
    const kids = entries.get('Kids');
    if (kids?.type !== 'array' || !kids.values.length) throw unsupported();
    let count = 0;
    for (const kid of kids.values) count += visit(ref(kid), reference, depth + 1);
    if (pdfInteger(entries.get('Count')) !== count) throw unsupported();
    return count;
  }
  visit(ref(catalog.get('Pages')), null, 0);
  return result;
}
function admitted(source, request) {
  checkedSource(source); const structure = parsePdfStructure(source); if (sourceHash(source) !== request.sourceSha256) throw unsupported(); const allPages = pages(structure); const page = allPages[request.target.page - 1]; if (!page || page.entries.get('Annots')?.type !== 'array' || page.entries.get('Annots').values.length !== 1) throw unsupported();
  for (const candidate of allPages) if (candidate !== page && candidate.entries.has('Annots')) throw unsupported();
  const annotationReference = ref(page.entries.get('Annots').values[0]); const annotation = resolvePdfObject(structure, annotationReference); if (annotation.stream || annotation.compressed) throw unsupported(); const a = pdfDictionary(annotation.value); onlyKeys(a, ANNOTATION_KEYS);
  if (a.get('Type')?.value !== 'Annot' || a.get('Subtype')?.value !== 'Square' || pdfInteger(a.get('F')) !== 4 || ['A','AA','PA','Dest','FS','Sound','Movie','RichMediaContent','3DD','Popup','OC'].some((key) => a.has(key))) throw unsupported(); const rect = directNumbers(a.get('Rect'), 4, true);
  const ap = pdfDictionary(a.get('AP')); if (ap.size !== 1 || ap.get('N')?.type !== 'ref') throw unsupported(); const appearanceReference = ref(ap.get('N')); const appearance = resolvePdfObject(structure, appearanceReference); const f = pdfDictionary(appearance.value); onlyKeys(f, FORM_KEYS);
  if (!appearance.stream || appearance.compressed || f.get('Type')?.value !== 'XObject' || f.get('Subtype')?.value !== 'Form' || f.get('Resources')?.type !== 'dict' || f.get('Resources').entries.size !== 0 || f.get('Length')?.type !== 'number' || !f.get('Length').integer || f.get('Length').value !== appearance.streamLength) throw unsupported(); directNumbers(f.get('BBox'), 4, true); if (f.has('Matrix') && JSON.stringify(directNumbers(f.get('Matrix'), 6)) !== '[1,0,0,1,0,0]') throw unsupported(); formContent(source.subarray(appearance.streamStart, appearance.streamStart + appearance.streamLength));
  const resources = pdfDictionary(page.entries.get('Resources')); if (resources.has('XObject')) throw unsupported(); const fingerprint = createHash('sha256').update(`pdfkit-inspector:opaque-locator:v1\nsource-sha256=${request.sourceSha256}\npage=${request.target.page}\nannotation-index=0\nsubtype=square\nwidget-type=none`, 'utf8').digest('hex'); if (fingerprint !== request.target.fingerprint) throw unsupported(); return { structure, page, annotationReference, appearanceReference, rect, resources };
}
function contents(value) { if (value === undefined) return []; if (value?.type === 'ref') return [ref(value)]; if (value?.type === 'array' && value.values.every((v) => v?.type === 'ref')) return value.values.map(ref); throw unsupported(); }
function transform(rect, bbox) { const [x0, y0, x1, y1] = rect; const [bx0, by0, bx1, by1] = bbox; const sx = (x1 - x0) / (bx1 - bx0); const sy = (y1 - y0) / (by1 - by0); return [sx, 0, 0, sy, x0 - (bx0 * sx), y0 - (by0 * sy)]; }
function changedId(source) { return createHash('sha256').update('Platen square annotation flatten ID v1\0', 'utf8').update(createHash('sha256').update(source).digest()).digest().subarray(0, 16); }
function canonical(source, request) {
  const p = admitted(source, request); const form = resolvePdfObject(p.structure, p.appearanceReference); const bbox = directNumbers(pdfDictionary(form.value).get('BBox'), 4, true); const matrix = transform(p.rect, bbox);
  if (matrix.some((value) => !Number.isFinite(value))) throw unsupported(); const stream = Buffer.from(`q ${matrix.join(' ')} cm /PWF0 Do Q\n`, 'latin1'); const handle = pendingPdfObjectReference('content');
  const resources = dict([...p.resources, ['XObject', dict([['PWF0', p.appearanceReference]])]]);
  const page = dict([...p.page.entries].filter(([key]) => key !== 'Annots' && key !== 'Resources' && key !== 'Contents').concat([['Resources', resources], ['Contents', array([...contents(p.page.entries.get('Contents')), handle])]]));
  const changingId = p.structure.id && p.structure.id[1].length === 16
    ? changedId(source) : p.structure.id ? (() => { throw unsupported(); })() : null;
  const transaction = planPdfObjectDeletionTransaction({ sourceBytes: source, sourceStructure: p.structure, deletions: [authorizePdfObjectDeletion(p.structure, p.annotationReference)], updates: [{ reference: p.page.reference, value: page }], additions: [{ id: 'content', value: dict([['Length', num(stream.length)]]), streamBytes: stream }], info: { kind: 'preserve' }, changingId });
  return { p, stream, transaction, appended: Buffer.concat([source, transaction.revision.bytes]) };
}
function outputProof(source, output, request) {
  const sourceProfile = admitted(source, request); const sourceStructure = sourceProfile.structure;
  const classic = parseClassicPdfStructure(output); const parsed = parsePdfStructure(output); const list = pages(parsed); const selected = list[request.target.page - 1];
  if (classic.revisions.length !== 1 || classic.revisions[0].trailer.has('Prev')
    || !same(classic.root, sourceStructure.root)
    || Boolean(classic.info) !== Boolean(sourceStructure.info)
    || (classic.info && !same(classic.info, sourceStructure.info))
    || Boolean(classic.id) !== Boolean(sourceStructure.id)
    || (classic.id && (!classic.id[0].equals(sourceStructure.id[0]) || !classic.id[1].equals(changedId(source))))
    || list.length !== pages(sourceProfile.structure).length
    || !selected || selected.entries.has('Annots')) throw invalidOutput();
  const resources = pdfDictionary(selected.entries.get('Resources')); const xobjects = pdfDictionary(resources.get('XObject'));
  if (xobjects.size !== 1 || !same(ref(xobjects.get('PWF0')), sourceProfile.appearanceReference)) throw invalidOutput();
  const selectedContents = selected.entries.get('Contents');
  if (selectedContents?.type !== 'array' || selectedContents.values.length < 1) throw invalidOutput();
  const appendedReference = ref(selectedContents.values.at(-1)); const appended = resolvePdfObject(parsed, appendedReference);
  const sourceAppearance = resolvePdfObject(sourceProfile.structure, sourceProfile.appearanceReference);
  const outputAppearance = resolvePdfObject(parsed, sourceProfile.appearanceReference);
  const bbox = directNumbers(pdfDictionary(sourceAppearance.value).get('BBox'), 4, true);
  const expectedStream = Buffer.from(`q ${transform(sourceProfile.rect, bbox).join(' ')} cm /PWF0 Do Q\n`, 'latin1');
  if (!appended.stream || !output.subarray(appended.streamStart, appended.streamStart + appended.streamLength).equals(expectedStream)
    || serializePdfValue(outputAppearance.value) !== serializePdfValue(sourceAppearance.value)
    || !output.subarray(outputAppearance.streamStart, outputAppearance.streamStart + outputAppearance.streamLength)
      .equals(source.subarray(sourceAppearance.streamStart, sourceAppearance.streamStart + sourceAppearance.streamLength))) throw invalidOutput();
  for (const page of list) if (page.entries.has('Annots')) throw invalidOutput();
  for (const entry of parsed.effective.values()) {
    if (entry.status !== 'n') continue;
    const object = resolvePdfObject(parsed, { type: 'ref', object: entry.object, generation: entry.generation });
    if (object.value?.type === 'dict' && object.value.entries.get('Type')?.value === 'Annot') throw invalidOutput();
  }
  try { resolvePdfObject(parsed, sourceProfile.annotationReference); throw invalidOutput(); } catch (error) { if (error?.code === 'INVALID_ANNOTATION_FLATTEN_OUTPUT') throw error; }
  return Object.freeze({
    profile: ANNOTATION_FLATTEN_PROFILE, sourceBytes: source.length, outputBytes: output.length,
    sourceSha256: sourceHash(source), outputSha256: sourceHash(output), sourcePrefixPreserved: false,
    closedClassicRevision: true, priorRevisionsAbsent: true, revisionCount: classic.revisions.length,
    annotationRemoved: true, removedReferenceUnresolvable: true, appearancePreserved: true,
    appearancePromotedToPageContent: true, rootPreserved: true, infoPreserved: true,
    idPolicy: sourceStructure.id ? 'permanent-preserved-changing-updated' : 'absent',
  });
}
function build(source, request) { const transaction = canonical(source, request); verifyPdfDeletionIncrementalRevision({ sourceBytes: source, outputBytes: transaction.appended, sourceStructure: transaction.p.structure, expectedRevision: transaction.transaction.revision }); const rewrite = buildPdfCompactRewrite(transaction.appended); verifyPdfCompactRewrite({ sourceBytes: transaction.appended, outputBytes: rewrite.bytes, expectedRewrite: rewrite }); return Object.freeze({ bytes: rewrite.bytes, proof: outputProof(source, rewrite.bytes, request) }); }
export function writeIncrementalAnnotationFlatten(sourceBytes, requestValue) { const request = normalizeAnnotationFlatten(requestValue); try { return build(sourceBytes, request); } catch (error) { if (['INVALID_ANNOTATION_FLATTEN', 'UNSUPPORTED_ANNOTATION_FLATTEN_PDF'].includes(error?.code)) throw error; throw unsupported(); } }
export function inspectIncrementalAnnotationFlatten(sourceBytes, outputBytes, requestValue) { const request = normalizeAnnotationFlatten(requestValue); try { const rebuilt = build(sourceBytes, request); if (!Buffer.isBuffer(outputBytes) || !rebuilt.bytes.equals(outputBytes)) throw invalidOutput(); return rebuilt.proof; } catch (error) { if (['INVALID_ANNOTATION_FLATTEN', 'INVALID_ANNOTATION_FLATTEN_OUTPUT'].includes(error?.code)) throw error; throw invalidOutput(); } }
export { ANNOTATION_FLATTEN_PROFILE };
