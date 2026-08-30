import { PlatenError } from './errors.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_PRINTER_MARKS_PROFILE = 'local-pdf-printer-marks-v1';
export const PDF_PRINTER_MARKS_VALIDATORS = Object.freeze(['source-sha256', 'private-source-copy', 'printer-marks-proof', 'artifact-sha256']);
export const PDF_PRINTER_MARKS_LIMITATIONS = Object.freeze([
  'Marks are deterministic passive black vector lines outside TrimBox and inside BleedBox.',
  'This local operation does not provide trapping, registration/color bars, imposition, PDF/X conformance, or printer equivalence.',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const PAGE_KEYS = Object.freeze(['page', 'reference', 'mediaBox', 'cropBox', 'bleedBox', 'trimBox', 'operatorBytes', 'operatorSha256', 'lines', 'foundationEdit']);
const EVIDENCE_KEYS = Object.freeze(['sourcePrefixPreserved', 'outputDigestBound', 'sourceUnchanged', 'localOnly']);
const invalid = () => { throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid source-bound printer-marks result.'); };
const exactPlain = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && !Object.getOwnPropertyDescriptor(value, key)?.get && !Object.getOwnPropertyDescriptor(value, key)?.set)
  && Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key));
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000;
const plainArray = (value, length) => {
  if (!Array.isArray(value) || value.length !== length || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value);
  return keys.length === length + 1 && keys.every((key) => key === 'length' || /^\d+$/u.test(key))
    && Array.from({ length }, (_, index) => Object.hasOwn(value, String(index))).every(Boolean)
    && Object.entries(descriptors).every(([key, descriptor]) => !descriptor.get && !descriptor.set && (key === 'length' ? descriptor.enumerable === false : descriptor.enumerable === true));
};
const box = (value) => plainArray(value, 4) && value.every(finiteNumber);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const digest = (value) => typeof value === 'string' && SHA256.test(value);
const exactObject = exactPlain;
function expectedLines(bleed, trim) {
  const margins = [trim[0] - bleed[0], trim[1] - bleed[1], bleed[2] - trim[2], bleed[3] - trim[3]];
  const length = Math.min(18, Math.max(1, (Math.min(...margins) - 2) / 2)); const gap = 1;
  const [x0, y0, x1, y1] = trim;
  return [[x0 - gap - length, y1 + gap, x0 - gap, y1 + gap], [x0 - gap, y1 + gap, x0 - gap, y1 + gap + length], [x1 + gap, y1 + gap, x1 + gap + length, y1 + gap], [x1 + gap, y1 + gap, x1 + gap, y1 + gap + length], [x0 - gap - length, y0 - gap, x0 - gap, y0 - gap], [x0 - gap, y0 - gap - length, x0 - gap, y0 - gap], [x1 + gap, y0 - gap, x1 + gap + length, y0 - gap], [x1 + gap, y0 - gap - length, x1 + gap, y0 - gap]];
}
const boundedArray = (value, maximum) => Array.isArray(value) && Number.isSafeInteger(value.length) && value.length >= 0 && value.length <= maximum
  && Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, String(index))).every(Boolean)
  && Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) => !descriptor.get && !descriptor.set && (key === 'length' ? descriptor.enumerable === false : descriptor.enumerable === true));

export function validPrinterMarksRequest(value) {
  return exactObject(value, ['pages']) && boundedArray(value.pages, 500) && value.pages.length >= 1 && value.pages.length <= 500
    && value.pages.every((page, index) => Number.isSafeInteger(page) && page >= 1 && page <= 500 && (index === 0 || page > value.pages[index - 1]));
}
function validArtifact(artifact, context) {
  return exactObject(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string' && artifact.displayName === 'printer-marks.pdf' && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64 && artifact.size <= 36 * 1024 * 1024 && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}
function validOperation(operation, artifact, context) {
  return exactObject(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '') && operation.type === 'pdf-printer-marks'
    && boundedArray(operation.inputs, 1) && operation.inputs.length === 1 && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId && operation.inputs[0].sha256 === context.sourceSha256 && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'pages']) && operation.parameters.profile === PDF_PRINTER_MARKS_PROFILE && boundedArray(operation.parameters.pages, context.request.pages.length) && operation.parameters.pages.length === context.request.pages.length && operation.parameters.pages.every((page, index) => page && page.page === context.request.pages[index])
    && exactObject(operation.expected, ['sourcePrefixPreserved', 'outputSha256']) && operation.expected.sourcePrefixPreserved === true && operation.expected.outputSha256 === artifact.sha256
    && exactObject(operation.validation, ['passed', 'validators', 'outputSha256']) && operation.validation.passed === true && plainArray(operation.validation.validators, PDF_PRINTER_MARKS_VALIDATORS.length) && operation.validation.validators.every((value, index) => value === PDF_PRINTER_MARKS_VALIDATORS[index]) && operation.validation.outputSha256 === artifact.sha256
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt));
}
function validPage(page, expected, expectedIndex) {
  if (!exactPlain(page, PAGE_KEYS) || page.page !== expected || !Number.isSafeInteger(page.page)
    || typeof page.reference !== 'string' || !/^\d+ \d+ R$/u.test(page.reference)
    || !box(page.mediaBox) || !box(page.cropBox) || !box(page.bleedBox) || !box(page.trimBox)
    || !Number.isSafeInteger(page.operatorBytes) || page.operatorBytes < 1 || page.operatorBytes > 4 * 1024 * 1024
    || !digest(page.operatorSha256) || !plainArray(page.lines, 8)
    || page.lines.some((line) => !plainArray(line, 4) || line.some((value) => !finiteNumber(value)))) return false;
  const [media, crop, bleed, trim] = [page.mediaBox, page.cropBox, page.bleedBox, page.trimBox];
  if (!(media[0] <= crop[0] && crop[0] <= bleed[0] && bleed[0] < trim[0]
    && media[1] <= crop[1] && crop[1] <= bleed[1] && bleed[1] < trim[1]
    && media[2] >= crop[2] && crop[2] >= bleed[2] && bleed[2] > trim[2]
    && media[3] >= crop[3] && crop[3] >= bleed[3] && bleed[3] > trim[3])) return false;
  if (!same(page.lines, expectedLines(bleed, trim)) || page.lines.some(([x1, y1, x2, y2]) => [x1, y1, x2, y2].some((value, index) => index % 2 === 0 ? value < bleed[0] || value > bleed[2] : value < bleed[1] || value > bleed[3])
    || ([x1, y1, x2, y2].every((value, index) => index % 2 === 0 ? value >= trim[0] && value <= trim[2] : value >= trim[1] && value <= trim[3])))) return false;
  const foundationKeys = ['index', 'page', 'position', 'reference', 'objectNumber', 'generation', 'bytes', 'sha256', 'tokenCount', 'operatorCounts'];
  if (!exactPlain(page.foundationEdit, foundationKeys) || page.foundationEdit.index !== expectedIndex
    || page.foundationEdit.page !== page.page || page.foundationEdit.position !== 'append' || !/^\d+ \d+ R$/u.test(page.foundationEdit.reference)
    || !Number.isSafeInteger(page.foundationEdit.objectNumber) || page.foundationEdit.objectNumber < 1 || page.foundationEdit.generation !== 0
    || page.foundationEdit.bytes !== page.operatorBytes || page.foundationEdit.sha256 !== page.operatorSha256
    || page.foundationEdit.reference !== `${page.foundationEdit.objectNumber} ${page.foundationEdit.generation} R`
    || !Number.isSafeInteger(page.foundationEdit.tokenCount) || page.foundationEdit.tokenCount < 1 || page.foundationEdit.tokenCount > 1_000_000
    || !exactPlain(page.foundationEdit.operatorCounts, ['g', 'G', 'J', 'l', 'm', 'q', 'Q', 'S', 'w'])
    || Object.values(page.foundationEdit.operatorCounts).some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
    || JSON.stringify(page.foundationEdit.operatorCounts) !== JSON.stringify({ g: 1, G: 1, J: 1, l: 8, m: 8, q: 1, Q: 1, S: 8, w: 1 })) return false;
  return true;
}
export function validatePrinterMarksResult(result, context) {
  if (!exactObject(result, ['kind', 'sourceDigest', 'artifact', 'pages', 'evidence', 'limitations']) || result.kind !== 'pdf-printer-marks' || result.sourceDigest !== context.sourceSha256
    || !validPrinterMarksRequest({ pages: context.request.pages }) || !plainArray(result.pages, context.request.pages.length)
    || result.pages.some((page, index) => !validPage(page, context.request.pages[index], index)) || !validArtifact(result.artifact, context)
    || !exactObject(result.evidence, EVIDENCE_KEYS) || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !plainArray(result.limitations, PDF_PRINTER_MARKS_LIMITATIONS.length) || result.limitations.some((value, index) => value !== PDF_PRINTER_MARKS_LIMITATIONS[index]) || !validOperation(result.artifact.operation, result.artifact, context)
    || !plainArray(result.artifact.operation.parameters.pages, context.request.pages.length) || result.artifact.operation.parameters.pages.some((entry, index) => !exactPlain(entry, ['page', 'bleedBox', 'trimBox', 'lines']) || !box(entry.bleedBox) || !box(entry.trimBox) || !plainArray(entry.lines, 8) || entry.lines.some((line) => !plainArray(line, 4) || line.some((value) => !finiteNumber(value))) || entry.page !== result.pages[index].page || !same(entry.bleedBox, result.pages[index].bleedBox) || !same(entry.trimBox, result.pages[index].trimBox) || !same(entry.lines, result.pages[index].lines))) invalid();
  return result;
}
