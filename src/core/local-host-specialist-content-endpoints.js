import { OPAQUE_ID_PATTERN, exactObject } from './pdfkit-client-contract-shared.js';

const PROFILE = 'local-pdf-specialist-content-v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const SUBTYPES = new Set(['3D', 'RichMedia', 'Screen', 'Movie', 'Sound', 'FileAttachment']);
const UNITS = new Set(['pt', 'in', 'cm', 'mm', 'm', 'km', 'ft', 'yd', 'mi', 'deg', 'rad']);
const LIMITATIONS = Object.freeze(['Read-only inventory only; no extraction, playback, scripting, authoring, or safety/conformance claim.', 'Payload bytes, names, text, and filesystem paths are omitted from the privacy-minimal result.', 'Malformed, aliased, cyclic, filtered, or resource-ambiguous specialist content is rejected rather than guessed.']);
const EVIDENCE_KEYS = ['readOnly', 'payloadBytesReturned', 'namesReturned', 'textReturned', 'pathsReturned', 'objectReferencesReturned', 'aliasCount', 'cycleChecked', 'bounded', 'sourceDigestReverified', 'sourceUnchangedDuringExtraction'];
const BOOLEAN_EVIDENCE_KEYS = new Set(['readOnly', 'payloadBytesReturned', 'namesReturned', 'textReturned', 'pathsReturned', 'objectReferencesReturned', 'cycleChecked', 'bounded', 'sourceDigestReverified', 'sourceUnchangedDuringExtraction']);

function invalid(message = 'Specialist-content result is invalid.') { throw new TypeError(message); }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }
function integer(value, maximum = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function exact(value, keys) {
  if (!exactObject(value, keys)) invalid();
  if (Reflect.ownKeys(value).length !== keys.length) invalid();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid();
  return value;
}
function plainArray(value, maximum = 50_000) {
  if (!Array.isArray(value)) invalid();
  if (value.length > maximum) invalid();
  if (Object.getOwnPropertySymbols(value).length) invalid();
  if (Object.keys(value).length !== value.length) invalid();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor, index) => index < value.length && (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true))) invalid();
  return value;
}
function nullablePage(value, result) {
  if (value.page === null) return;
  if (!integer(value.page, result.pageCount)) invalid();
  if (value.page < 1) invalid();
}
function validateRoot(result, sourceSha256) {
  if (result.profile !== PROFILE) invalid();
  if (result.sourceSha256 !== sourceSha256) invalid();
  if (!integer(result.pageCount, 1_000)) invalid();
  if (result.pageCount < 1) invalid();
  plainArray(result.limitations, 3);
  if (JSON.stringify(result.limitations) !== JSON.stringify(LIMITATIONS)) invalid();
}
function validateFlagSet(flags, collection) {
  exact(flags, ['present', flags === collection.sortFlags ? 'descending' : 'standard']);
  if (typeof flags.present !== 'boolean') invalid();
  if (typeof flags[flags === collection.sortFlags ? 'descending' : 'standard'] !== 'boolean') invalid();
}
function validateCollection(value) {
  const collection = exact(value, ['present', 'schemaFieldCount', 'sortFlags', 'viewFlags']);
  if (typeof collection.present !== 'boolean') invalid();
  if (!integer(collection.schemaFieldCount, 10_000)) invalid();
  for (const flags of [collection.sortFlags, collection.viewFlags]) validateFlagSet(flags, collection);
}
function validateEmbeddedRecord(record, index, result) {
  exact(record, ['ordinal', 'page', 'bytes', 'sha256']);
  if (record.ordinal !== index + 1) invalid();
  nullablePage(record, result);
  if (!integer(record.bytes, 64 * 1024 * 1024)) invalid();
  if (!SHA256.test(record.sha256)) invalid();
  return record.bytes;
}
function validateEmbeddedFiles(value, result) {
  const embedded = exact(value, ['count', 'aggregateBytes', 'records', 'truncated']);
  plainArray(embedded.records);
  if (!integer(embedded.count, 4_000)) invalid();
  if (!integer(embedded.aggregateBytes, 64 * 1024 * 1024)) invalid();
  if (embedded.records.length !== embedded.count) invalid();
  if (typeof embedded.truncated !== 'boolean') invalid();
  let aggregate = 0;
  embedded.records.forEach((record, index) => { aggregate += validateEmbeddedRecord(record, index, result); });
  if (aggregate !== embedded.aggregateBytes) invalid();
}
function validateAnnotationLocus(locus, result) {
  exact(locus, ['page', 'subtype']);
  if (!integer(locus.page, result.pageCount)) invalid();
  if (locus.page < 1) invalid();
  if (!SUBTYPES.has(locus.subtype)) invalid();
}
function validateAnnotations(value, result) {
  const annotations = exact(value, ['subtypeCounts', 'loci', 'activationCount', 'actionCount']);
  const counts = exact(annotations.subtypeCounts, [...SUBTYPES]);
  plainArray(annotations.loci);
  if ([...SUBTYPES].some((name) => !integer(counts[name], 50_000))) invalid();
  if (!integer(annotations.activationCount, 50_000)) invalid();
  if (!integer(annotations.actionCount, 50_000)) invalid();
  annotations.loci.forEach((locus) => validateAnnotationLocus(locus, result));
  for (const subtype of SUBTYPES) if (annotations.loci.filter(({ subtype: value }) => value === subtype).length !== counts[subtype]) invalid();
}
function validateGeospatialSummary(summary) {
  exact(summary, ['kind', 'unit', 'digest']);
  if (summary.kind !== 'measure') invalid();
  if (summary.unit !== null && !UNITS.has(summary.unit)) invalid();
  if (!SHA256.test(summary.digest)) invalid();
}
function validateGeospatial(value) {
  const geo = exact(value, ['measureCount', 'vpCount', 'lgidictCount', 'summaries']);
  plainArray(geo.summaries);
  if (![geo.measureCount, geo.vpCount, geo.lgidictCount].every((count) => integer(count, 4_000))) invalid();
  if (geo.summaries.length !== geo.measureCount) invalid();
  geo.summaries.forEach(validateGeospatialSummary);
}
function validateAssociatedLocus(locus, index, result) {
  exact(locus, ['ordinal', 'page']);
  if (locus.ordinal !== index + 1) invalid();
  nullablePage(locus, result);
}
function validateAssociatedFiles(value, result) {
  const associated = exact(value, ['count', 'loci']);
  plainArray(associated.loci);
  if (!integer(associated.count, 50_000)) invalid();
  if (associated.loci.length !== associated.count) invalid();
  associated.loci.forEach((locus, index) => validateAssociatedLocus(locus, index, result));
}
function validateRenditionMedia(value) {
  const rendition = exact(value, ['renditionCount', 'mediaActionCount']);
  if (!integer(rendition.renditionCount, 50_000)) invalid();
  if (!integer(rendition.mediaActionCount, 50_000)) invalid();
}
function validateEvidenceTypes(evidence) {
  for (const key of EVIDENCE_KEYS) if (BOOLEAN_EVIDENCE_KEYS.has(key) && typeof evidence[key] !== 'boolean') invalid();
}
function requireEvidenceValue(evidence, key, expected) {
  if (evidence[key] !== expected) invalid();
}
function validateEvidence(value) {
  const evidence = exact(value, EVIDENCE_KEYS);
  validateEvidenceTypes(evidence);
  if (!integer(evidence.aliasCount, 50_000)) invalid();
  requireEvidenceValue(evidence, 'readOnly', true);
  requireEvidenceValue(evidence, 'payloadBytesReturned', false);
  requireEvidenceValue(evidence, 'namesReturned', false);
  requireEvidenceValue(evidence, 'textReturned', false);
  requireEvidenceValue(evidence, 'pathsReturned', false);
  requireEvidenceValue(evidence, 'objectReferencesReturned', false);
  requireEvidenceValue(evidence, 'cycleChecked', true);
  requireEvidenceValue(evidence, 'bounded', true);
  requireEvidenceValue(evidence, 'sourceDigestReverified', true);
  requireEvidenceValue(evidence, 'sourceUnchangedDuringExtraction', true);
}
function validateResult(value, sourceSha256) {
  const result = exact(value, ['profile', 'sourceSha256', 'pageCount', 'collection', 'embeddedFiles', 'annotations', 'geospatial', 'associatedFiles', 'renditionMedia', 'evidence', 'limitations']);
  validateRoot(result, sourceSha256);
  validateCollection(result.collection);
  validateEmbeddedFiles(result.embeddedFiles, result);
  validateAnnotations(result.annotations, result);
  validateGeospatial(result.geospatial);
  validateAssociatedFiles(result.associatedFiles, result);
  validateRenditionMedia(result.renditionMedia);
  validateEvidence(result.evidence);
  return freeze(result);
}

export function createSpecialistContentEndpoints({ json }) {
  return Object.freeze({ inspectSpecialistContent(documentId, sourceSha256, options = {}) {
    const optionKeys = options?.signal === undefined ? [] : ['signal'];
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '') || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Specialist-content options are invalid.');
    return json(`/api/documents/${encodeURIComponent(documentId)}/specialist-content`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: PROFILE, sourceSha256 }), signal: options.signal }).then((body) => validateResult(body?.result, sourceSha256));
  } });
}
