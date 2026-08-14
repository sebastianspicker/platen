import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { normalizePdfXfaInspectionRequest, PDF_XFA_INSPECTION_LIMITS, PDF_XFA_INSPECTION_PROFILE } from './pdf-xfa-inspection-contract.mjs';

function failure(message = 'The source is outside the bounded XFA inspection subset.') {
  const error = new Error(message);
  error.code = 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE';
  throw error;
}

function outputFailure() {
  const error = new Error('The XFA inspection result failed independent verification.');
  error.code = 'INVALID_PDF_XFA_INSPECTION_OUTPUT';
  throw error;
}

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function checkedRequest(source, value) {
  let request;
  try { request = normalizePdfXfaInspectionRequest(value); } catch { failure('The inspection request is invalid.'); }
  if (sha(source) !== request.sourceSha256) failure('sourceSha256 does not match source bytes.');
  return request;
}

function parseSource(source) {
  if (!Buffer.isBuffer(source) || (typeof SharedArrayBuffer !== 'undefined' && source.buffer instanceof SharedArrayBuffer)
    || source.length < 32 || source.length > PDF_XFA_INSPECTION_LIMITS.maxSourceBytes) failure('Source bytes are outside the fixed bound.');
  let structure;
  try { structure = parseClassicPdfStructure(source); } catch { failure('Only valid classic-xref PDFs are admitted.'); }
  if (structure.revisions.length !== 1 || structure.info || structure.id
    || structure.revisions.some((revision) => revision.trailer.has('Encrypt'))) failure('Only one unencrypted classic revision without Info or IDs is admitted.');
  const effective = [...structure.effective.values()].filter((entry) => entry.status === 'n' && entry.object !== 0);
  if (effective.length > PDF_XFA_INSPECTION_LIMITS.maxObjects || [...structure.effective.values()].some((entry) => entry.status === 'c')) failure('The PDF object table is outside the fixed inspection bound.');
  return Object.freeze({ structure, effectiveObjectCount: effective.length });
}

function analyze(source, request, parsed) {
  const root = parsed.structure.root;
  if (root?.type !== 'ref') failure('Root must be an indirect catalog reference.');
  let catalogObject;
  try { catalogObject = resolveClassicPdfObject(parsed.structure, root); } catch { failure('Root must resolve to a classic catalog object.'); }
  if (catalogObject.stream) failure('Catalog must not be a stream.');
  let catalog;
  try { catalog = pdfDictionary(catalogObject.value); } catch { failure('Catalog must be a dictionary.'); }
  if (catalog.get('Type')?.type !== 'name' || catalog.get('Type').value !== 'Catalog') failure('Root must be a Catalog dictionary.');
  const acroFormValue = catalog.get('AcroForm');
  let acroForm = null;
  if (acroFormValue !== undefined) {
    if (acroFormValue?.type !== 'dict') failure('AcroForm must be a direct dictionary when present.');
    try { acroForm = pdfDictionary(acroFormValue); } catch { failure('AcroForm must be a direct dictionary when present.'); }
  }
  const xfaPresent = catalog.has('XFA') || Boolean(acroForm?.has('XFA'));
  return Object.freeze({
    schema: 'pdf-xfa-presence-inspection-v1',
    profile: PDF_XFA_INSPECTION_PROFILE,
    sourceSha256: request.sourceSha256,
    sourceBytes: source.length,
    revisionCount: 1,
    effectiveObjectCount: parsed.effectiveObjectCount,
    xfaPresent,
    inspection: 'catalog-and-direct-acroform-key-presence-only',
  });
}

export function analyzePdfXfaPresence(sourceBytes, value) {
  if (!Buffer.isBuffer(sourceBytes) || (typeof SharedArrayBuffer !== 'undefined' && sourceBytes.buffer instanceof SharedArrayBuffer)) failure('Source bytes must be a private Buffer.');
  const source = Buffer.from(sourceBytes);
  const request = checkedRequest(source, value);
  return analyze(source, request, parseSource(source));
}

function stableCandidate(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    if (isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) outputFailure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((entry) => entry !== 'length' && (!/^\d+$/u.test(String(entry)) || !Object.hasOwn(descriptors[entry], 'value') || descriptors[entry].enumerable !== true))) outputFailure();
    return value.map(stableCandidate);
  }
  if (!value || typeof value !== 'object' || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((entry) => typeof entry !== 'string')) outputFailure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) outputFailure();
  return Object.fromEntries(Object.entries(descriptors).map(([entry, descriptor]) => [entry, stableCandidate(descriptor.value)]));
}

export function inspectPdfXfaPresenceAnalysis(sourceBytes, value, candidate) {
  const expected = analyzePdfXfaPresence(sourceBytes, value);
  let normalized;
  try { normalized = stableCandidate(candidate); } catch (error) { if (error?.code === 'INVALID_PDF_XFA_INSPECTION_OUTPUT') throw error; outputFailure(); }
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) outputFailure();
  return expected;
}
