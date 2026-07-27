import { createHash } from 'node:crypto';
import { pdfDictionary, pdfReference } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, parsePdfStructure, resolveClassicPdfObject, resolvePdfObject } from './pdf-classic-structure.mjs';
import { resolvePdfPageTree } from './pdf-page-tree-resolver.mjs';
import { PDF_SPECIALIST_CONTENT_PROFILE, normalizePdfSpecialistContent } from './pdf-specialist-content-contract.mjs';

export { PDF_SPECIALIST_CONTENT_PROFILE };
export const PDF_SPECIALIST_CONTENT_LIMITS = Object.freeze({ maxSourceBytes: 64 * 1024 * 1024, maxPages: 1_000, maxObjects: 50_000, maxDepth: 16, maxStreams: 4_000, maxAggregateStreamBytes: 64 * 1024 * 1024 });
const ANNOTATION_SUBTYPES = Object.freeze(['3D', 'RichMedia', 'Screen', 'Movie', 'Sound', 'FileAttachment']);
const SAFE_UNITS = new Set(['pt', 'in', 'cm', 'mm', 'm', 'km', 'ft', 'yd', 'mi', 'deg', 'rad']);
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'PDF is outside the bounded specialist-content inspection subset.') { return fail('UNSUPPORTED_PDF_SPECIALIST_CONTENT', message); }
function invalidOutput(message = 'PDF specialist-content inventory proof failed.') { return fail('INVALID_PDF_SPECIALIST_CONTENT_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function refKey(ref) { return `${ref.object}:${ref.generation}`; }
function dict(value) { try { return pdfDictionary(value); } catch { throw unsupported('Malformed dictionary encountered during specialist-content inspection.'); } }
function asRef(value) { try { return pdfReference(value); } catch { throw unsupported('Malformed object reference encountered during specialist-content inspection.'); } }
function safeName(value) { return value?.type === 'name' ? value.value : null; }
function scalarDigest(value) { return digest(Buffer.from(JSON.stringify(value), 'utf8')); }
function frozen(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) frozen(child); return Object.freeze(value); }

function scanSource(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 32 || sourceBytes.length > PDF_SPECIALIST_CONTENT_LIMITS.maxSourceBytes || digest(sourceBytes) !== request.sourceSha256) throw fail('INVALID_PDF_SPECIALIST_CONTENT', 'The source digest does not match source bytes.');
  let structure; try { const parsed = parsePdfStructure(sourceBytes); structure = parsed.xrefFlavor === 'classic' || parsed.xrefFlavor === undefined ? parseClassicPdfStructure(sourceBytes) : parsed; } catch { throw unsupported('The PDF structure is malformed or exceeds parser bounds.'); }
  let tree; try { tree = resolvePdfPageTree({ structure, limits: { maxPages: PDF_SPECIALIST_CONTENT_LIMITS.maxPages, maxNodes: 10_000, maxDepth: 64 } }); } catch { throw unsupported('The page tree is malformed or exceeds inspection bounds.'); }
  if (structure.effective.size > PDF_SPECIALIST_CONTENT_LIMITS.maxObjects) throw unsupported('The object inventory exceeds the fixed bound.');
  const seen = new Set(); const processedRefs = new Set(); const active = new Set(); let aliasCount = 0; let streamCount = 0; let aggregateStreamBytes = 0; const streams = new Map();
  const collection = { present: false, schemaFieldCount: 0, sortFlags: Object.create(null), viewFlags: Object.create(null) };
  const embedded = new Map(); const associated = []; const annotationLoci = []; const subtypeCounts = Object.fromEntries(ANNOTATION_SUBTYPES.map((name) => [name, 0])); let activationCount = 0; let actionCount = 0; let renditionCount = 0; let mediaActionCount = 0; const geo = { measureCount: 0, vpCount: 0, lgidictCount: 0, summaries: [] };
  const resolve = structure.xrefFlavor === 'classic' || structure.xrefFlavor === undefined ? resolveClassicPdfObject : resolvePdfObject;
  function streamInfo(ref) {
    const normalized = asRef(ref); const key = refKey(normalized); if (streams.has(key)) return streams.get(key); const object = resolve(structure, normalized); if (!object.stream || !Number.isSafeInteger(object.streamLength) || object.streamLength < 0) throw unsupported('Malformed stream length encountered.'); streamCount += 1; aggregateStreamBytes += object.streamLength; if (streamCount > PDF_SPECIALIST_CONTENT_LIMITS.maxStreams || aggregateStreamBytes > PDF_SPECIALIST_CONTENT_LIMITS.maxAggregateStreamBytes) throw unsupported('Stream inventory exceeds fixed bounds.'); const info = Object.freeze({ reference: normalized, bytes: object.streamLength, sha256: digest(sourceBytes.subarray(object.streamStart, object.streamStart + object.streamLength)) }); streams.set(key, info); return info; }
  function walk(value, depth = 0, owner = null) {
    if (depth > PDF_SPECIALIST_CONTENT_LIMITS.maxDepth) throw unsupported('Specialist-content object depth exceeds the fixed bound.');
    if (!value || typeof value !== 'object') return;
    if (value.type === 'ref') { const ref = asRef(value); const key = refKey(ref); if (active.has(key)) throw unsupported('Cyclic PDF object references are unsupported.'); if (seen.has(key)) { aliasCount += 1; return; } seen.add(key); processedRefs.add(key); active.add(key); const object = resolve(structure, ref); if (object.stream) { const info = streamInfo(ref); if (owner?.embedded && (!embedded.has(key) || embedded.get(key).page === null)) embedded.set(key, { ...info, page: owner.page ?? null }); } walk(object.value, depth + 1, owner); active.delete(key); return; }
    if (value.type === 'array') { for (const child of value.values) walk(child, depth + 1, owner); return; }
    if (value.type !== 'dict') return;
    const entries = value.entries; const type = safeName(entries.get('Type')); const subtype = safeName(entries.get('Subtype')); const action = safeName(entries.get('S'));
    if (entries.has('Collection') || type === 'Collection') { collection.present = true; const candidate = entries.get('Collection'); const c = candidate?.type === 'dict' ? candidate.entries : entries; const schema = c.get('Schema'); if (schema?.type === 'dict') collection.schemaFieldCount = schema.entries.size; else if (schema?.type === 'ref') { const schemaObject = resolve(structure, schema); const schemaEntries = dict(schemaObject.value); collection.schemaFieldCount = schemaEntries.size; } else if (schema !== undefined) throw unsupported('Collection schema is malformed.'); collection.sortFlags = Object.freeze({ present: c.has('Sort'), descending: Boolean(c.get('Sort')?.type === 'dict' && c.get('Sort').entries.has('D')) }); collection.viewFlags = Object.freeze({ present: c.has('View'), standard: safeName(c.get('View')) !== null }); }
    if (type === 'Filespec' || entries.has('EF')) { const ef = entries.get('EF'); if (ef?.type === 'dict') for (const child of ef.entries.values()) if (child?.type === 'ref') { const info = streamInfo(child); const embeddedKey = refKey(info.reference); if (!embedded.has(embeddedKey) || embedded.get(embeddedKey).page === null) embedded.set(embeddedKey, { ...info, page: owner?.page ?? null }); } }
    if (entries.has('AF')) { const af = entries.get('AF'); const refs = af?.type === 'array' ? af.values : [af]; for (const child of refs) if (child?.type === 'ref') associated.push(Object.freeze({ reference: refKey(asRef(child)), page: owner?.page ?? null })); else throw unsupported('Associated-file linkage is malformed.'); }
    if (subtype && ANNOTATION_SUBTYPES.includes(subtype)) { subtypeCounts[subtype] += 1; annotationLoci.push(Object.freeze({ page: owner?.page ?? null, subtype })); if (entries.has('A') || entries.has('AA') || entries.has('3DD') || entries.has('RichMediaContent')) activationCount += 1; }
    if (entries.has('A') || entries.has('AA') || action) actionCount += 1; if (type === 'Rendition' || subtype === 'MR') renditionCount += 1; if (action === 'Rendition' || action === 'Movie' || action === 'Sound' || action === 'Screen') mediaActionCount += 1;
    if (type === 'Measure') { geo.measureCount += 1; const unit = safeName(entries.get('U')) ?? safeName(entries.get('Subtype')); geo.summaries.push(Object.freeze({ kind: 'measure', unit: SAFE_UNITS.has(unit) ? unit : null, digest: scalarDigest({ type, unit: SAFE_UNITS.has(unit) ? unit : null }) })); }
    if (type === 'Viewport') geo.vpCount += 1; if (type === 'LGIDict') geo.lgidictCount += 1;
    for (const [name, child] of entries) if (name !== 'Parent') walk(child, depth + 1, owner);
  }
  tree.pages.forEach((page) => { const annots = dict(page.page.value).get('Annots'); if (annots?.type === 'array') annots.values.forEach((ref) => walk(ref, 0, { page: page.index + 1 })); else if (annots?.type === 'ref') walk(annots, 0, { page: page.index + 1 }); else if (annots !== undefined) throw unsupported('Page annotations are malformed.'); });
  for (const [objectNumber, entry] of structure.effective) { if (entry.status !== 'n' && entry.status !== 'c') continue; if (seen.size > PDF_SPECIALIST_CONTENT_LIMITS.maxObjects) throw unsupported(); const reference = { type: 'ref', object: objectNumber, generation: entry.generation }; const objectKey = refKey(reference); const object = resolve(structure, reference); if (object.stream) streamInfo({ type: 'ref', object: object.reference.object, generation: object.reference.generation }); if (!processedRefs.has(objectKey)) { processedRefs.add(objectKey); walk(object.value, 0); } }
  const catalog = dict(resolve(structure, structure.root).value); if (catalog.has('Collection')) { collection.present = true; walk(catalog.get('Collection'), 0); } const embeddedRecords = [...embedded.values()].map(({ bytes, sha256, page }, index) => Object.freeze({ ordinal: index + 1, page, bytes, sha256 }));
  const associatedRecords = associated.map(({ page }, index) => Object.freeze({ ordinal: index + 1, page }));
  return frozen({ profile: PDF_SPECIALIST_CONTENT_PROFILE, sourceSha256: digest(sourceBytes), pageCount: tree.pageCount, collection, embeddedFiles: { count: embeddedRecords.length, aggregateBytes: embeddedRecords.reduce((sum, item) => sum + item.bytes, 0), records: embeddedRecords, truncated: false }, annotations: { subtypeCounts, loci: annotationLoci, activationCount, actionCount }, geospatial: geo, associatedFiles: { count: associatedRecords.length, loci: associatedRecords }, renditionMedia: { renditionCount, mediaActionCount }, evidence: { readOnly: true, payloadBytesReturned: false, namesReturned: false, textReturned: false, pathsReturned: false, objectReferencesReturned: false, aliasCount, cycleChecked: true, bounded: true } });
}

export function inspectPdfSpecialistContent(sourceBytes, requestValue) { const request = normalizePdfSpecialistContent(requestValue); return scanSource(sourceBytes, request); }
export const inventoryPdfSpecialistContent = inspectPdfSpecialistContent;
