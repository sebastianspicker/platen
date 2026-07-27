import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { validateContentComparisonReceipt } from './comparison-report.mjs';
import { decodePng } from './raster-png-codec.mjs';
import { writeStoredZip } from './pdf-ooxml-export-zip.mjs';
import { readZipEntries } from './zip-reader.mjs';
import {
  COMPARISON_PACKAGE_EXTENSION, COMPARISON_PACKAGE_MAX_BYTES,
  COMPARISON_PACKAGE_MEDIA_TYPE,
} from './comparison-package-types.mjs';

export { COMPARISON_PACKAGE_EXTENSION, COMPARISON_PACKAGE_MAX_BYTES, COMPARISON_PACKAGE_MEDIA_TYPE };
export const COMPARISON_PACKAGE_SCHEMA_VERSION = 1;
export const COMPARISON_PACKAGE_LIMITS = Object.freeze({
  maximumPages: 200, maximumEntries: 204, maximumEntryBytes: 16 * 1024 * 1024,
  maximumArchiveBytes: COMPARISON_PACKAGE_MAX_BYTES, maximumDiffImageBytes: 8 * 1024 * 1024,
  maximumPixelsPerPage: 4_194_304,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function canonicalComparisonJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package JSON contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalComparisonJson).join(',')}]`;
  if (!value || typeof value !== 'object' || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package JSON must be plain data.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalComparisonJson(value[key])}`).join(',')}}`;
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail('COMPARISON_RECEIPT_INVALID', `${label} must be a non-proxy data record.`);
  const descriptors = Object.getOwnPropertyDescriptors(value); const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    || ownKeys.some((key) => !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('COMPARISON_RECEIPT_INVALID', `${label} has unexpected or active fields.`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function exactArray(value, maximum, label) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) fail('COMPARISON_RECEIPT_INVALID', `${label} must be a bounded native array.`);
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) fail('COMPARISON_RECEIPT_INVALID', `${label} must be a dense data array.`);
  return keys.map((key) => descriptors[key].value);
}

function sourceInputs(value, primaryDigest, revisionDigest, includeIds) {
  return exactArray(value, 2, 'Comparison source bindings').map((input, index) => {
    const keys = includeIds ? ['documentId', 'sha256', 'role'] : ['sha256', 'role'];
    const checked = exactRecord(input, keys, 'Comparison source binding');
    const role = index === 0 ? 'primary' : 'secondary'; const expectedDigest = index === 0 ? primaryDigest : revisionDigest;
    if (checked.role !== role || checked.sha256 !== expectedDigest || !SHA256.test(checked.sha256)) fail('COMPARISON_SOURCE_MISMATCH', 'Comparison receipt source bindings are invalid or out of order.', 409);
    return checked;
  });
}

export function contentReceiptBytes(exported, primaryDigest, revisionDigest) {
  const checked = exactRecord(exported, ['mediaType', 'extension', 'data'], 'Content comparison export');
  if (checked.mediaType !== 'application/json' || checked.extension !== 'json' || typeof checked.data !== 'string' || Buffer.byteLength(checked.data) > COMPARISON_PACKAGE_LIMITS.maximumEntryBytes) fail('COMPARISON_RECEIPT_INVALID', 'Content comparison receipt is missing or oversized.');
  let parsed; try { parsed = JSON.parse(checked.data); } catch (error) { fail('COMPARISON_RECEIPT_INVALID', 'Content comparison receipt is not valid JSON.', 502, error); }
  let stable; try { stable = validateContentComparisonReceipt(parsed); } catch (error) { fail('COMPARISON_RECEIPT_INVALID', 'Content comparison receipt failed structural validation.', 502, error); }
  if (canonicalComparisonJson(parsed) !== canonicalComparisonJson(stable)) fail('COMPARISON_RECEIPT_INVALID', 'Content comparison receipt contains unexpected fields.');
  sourceInputs(stable.inputs, primaryDigest, revisionDigest, false);
  return Buffer.from(canonicalComparisonJson(stable), 'utf8');
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('COMPARISON_RECEIPT_INVALID', `${label} is out of bounds.`);
  return value;
}

function dimensions(value, label) {
  const checked = exactRecord(value, ['width', 'height'], label);
  return Object.freeze({ width: integer(checked.width, 1, COMPARISON_PACKAGE_LIMITS.maximumPixelsPerPage, `${label} width`), height: integer(checked.height, 1, COMPARISON_PACKAGE_LIMITS.maximumPixelsPerPage, `${label} height`) });
}

function differenceImage(value, page, width, height) {
  const checked = exactRecord(value, ['format', 'encoding', 'sha256', 'data'], 'Comparison difference image');
  if (checked.format !== 'image/png' || checked.encoding !== 'base64' || !SHA256.test(checked.sha256) || typeof checked.data !== 'string') fail('COMPARISON_RECEIPT_INVALID', 'Comparison difference image metadata is invalid.');
  const bytes = Buffer.from(checked.data, 'base64');
  if (!bytes.length || bytes.length > COMPARISON_PACKAGE_LIMITS.maximumDiffImageBytes || bytes.toString('base64') !== checked.data
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || digest(bytes) !== checked.sha256) fail('COMPARISON_RECEIPT_INVALID', 'Comparison difference image bytes are invalid.');
  let decoded; try { decoded = decodePng(bytes, COMPARISON_PACKAGE_LIMITS.maximumPixelsPerPage); } catch (error) { fail('COMPARISON_RECEIPT_INVALID', 'Comparison difference image is not a valid bounded PNG.', 502, error); }
  if (decoded.width !== width || decoded.height !== height) fail('COMPARISON_RECEIPT_INVALID', 'Comparison difference image dimensions do not match its receipt.');
  const path = `diff/page-${String(page).padStart(3, '0')}.png`;
  return { bytes, record: Object.freeze({ path, mediaType: 'image/png', size: bytes.length, sha256: checked.sha256 }) };
}

export function visualReceiptEntries(report, primaryDigest, revisionDigest) {
  const root = exactRecord(report, ['kind', 'inputs', 'dpi', 'stats', 'pages'], 'Visual comparison receipt');
  if (root.kind !== 'pixel') fail('COMPARISON_RECEIPT_INVALID', 'Visual comparison receipt kind is invalid.');
  sourceInputs(root.inputs, primaryDigest, revisionDigest, true);
  const dpi = integer(root.dpi, 36, 240, 'Visual comparison DPI');
  const stats = exactRecord(root.stats, ['comparedPages', 'changedPixels', 'comparedPixels'], 'Visual comparison statistics');
  const pages = exactArray(root.pages, COMPARISON_PACKAGE_LIMITS.maximumPages, 'Visual comparison pages'); const images = [];
  let comparedPages = 0; let changedPixels = 0; let comparedPixels = 0;
  const receiptPages = pages.map((pageValue, index) => {
    if (!pageValue || typeof pageValue !== 'object' || isProxy(pageValue)) fail('COMPARISON_RECEIPT_INVALID', 'Visual comparison page must be a non-proxy data record.');
    const page = index + 1; const status = Object.getOwnPropertyDescriptor(pageValue, 'status')?.value;
    if (status === 'unpaired-page') {
      const value = exactRecord(pageValue, ['page', 'status', 'leftPresent', 'rightPresent'], 'Unpaired visual comparison page');
      if (value.page !== page || typeof value.leftPresent !== 'boolean' || typeof value.rightPresent !== 'boolean' || value.leftPresent === value.rightPresent) fail('COMPARISON_RECEIPT_INVALID', 'Unpaired visual comparison page is invalid.');
      return Object.freeze(value);
    }
    const value = exactRecord(pageValue, ['page', 'status', 'width', 'height', 'left', 'right', 'changedPixels', 'comparedPixels', 'dimensionMismatch', 'meanChannelDelta', 'maximumChannelDelta', 'differenceImage'], 'Compared visual page');
    if (value.page !== page || value.status !== 'compared' || typeof value.dimensionMismatch !== 'boolean' || !Number.isFinite(value.meanChannelDelta) || value.meanChannelDelta < 0 || value.meanChannelDelta > 255) fail('COMPARISON_RECEIPT_INVALID', 'Compared visual page metadata is invalid.');
    const width = integer(value.width, 1, COMPARISON_PACKAGE_LIMITS.maximumPixelsPerPage, 'Comparison width'); const height = integer(value.height, 1, COMPARISON_PACKAGE_LIMITS.maximumPixelsPerPage, 'Comparison height');
    const left = dimensions(value.left, 'Primary render'); const right = dimensions(value.right, 'Revision render');
    const pixels = integer(value.comparedPixels, 1, COMPARISON_PACKAGE_LIMITS.maximumPixelsPerPage, 'Compared pixels');
    const changed = integer(value.changedPixels, 0, pixels, 'Changed pixels'); const maximumDelta = integer(value.maximumChannelDelta, 0, 255, 'Maximum channel delta');
    if (pixels !== width * height || value.dimensionMismatch !== (left.width !== right.width || left.height !== right.height)) fail('COMPARISON_RECEIPT_INVALID', 'Visual comparison dimensions and counts are inconsistent.');
    const image = differenceImage(value.differenceImage, page, width, height); images.push(image); comparedPages += 1; changedPixels += changed; comparedPixels += pixels;
    return Object.freeze({ page, status: 'compared', width, height, left, right, changedPixels: changed, comparedPixels: pixels, dimensionMismatch: value.dimensionMismatch, meanChannelDelta: value.meanChannelDelta, maximumChannelDelta: maximumDelta, differenceImage: image.record });
  });
  if (integer(stats.comparedPages, 0, pages.length, 'Compared page count') !== comparedPages
    || integer(stats.changedPixels, 0, COMPARISON_PACKAGE_LIMITS.maximumPixelsPerPage * pages.length, 'Aggregate changed pixels') !== changedPixels
    || integer(stats.comparedPixels, 0, COMPARISON_PACKAGE_LIMITS.maximumPixelsPerPage * pages.length, 'Aggregate compared pixels') !== comparedPixels) fail('COMPARISON_RECEIPT_INVALID', 'Visual comparison aggregate statistics are inconsistent.');
  const receipt = Object.freeze({ kind: 'pixel', inputs: Object.freeze([{ role: 'primary', sha256: primaryDigest }, { role: 'revision', sha256: revisionDigest }]), dpi, stats: Object.freeze({ comparedPages, changedPixels, comparedPixels }), pages: Object.freeze(receiptPages) });
  return Object.freeze({ receipt: Buffer.from(canonicalComparisonJson(receipt), 'utf8'), images: Object.freeze(images) });
}

function entryRecord(path, mediaType, bytes) { return Object.freeze({ path, mediaType, size: bytes.length, sha256: digest(bytes) }); }

export function buildComparisonPackage({ primary, revision, contentReceipt, visual = null }) {
  if (!primary || !revision || primary.id === revision.id || !SHA256.test(primary.sha256) || !SHA256.test(revision.sha256)
    || !Number.isSafeInteger(primary.size) || primary.size < 1 || !Number.isSafeInteger(revision.size) || revision.size < 1) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package requires exactly two distinct bounded source records.', 400);
  const entries = [['receipts/content.json', contentReceipt]]; const records = [entryRecord('receipts/content.json', 'application/json', contentReceipt)];
  if (visual) {
    entries.push(['receipts/visual.json', visual.receipt]); records.push(entryRecord('receipts/visual.json', 'application/json', visual.receipt));
    for (const image of visual.images) { entries.push([image.record.path, image.bytes]); records.push(entryRecord(image.record.path, 'image/png', image.bytes)); }
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  const content = JSON.parse(contentReceipt.toString('utf8'));
  const manifest = Object.freeze({ schemaVersion: COMPARISON_PACKAGE_SCHEMA_VERSION, kind: 'local-comparison-package', sources: Object.freeze([
    Object.freeze({ role: 'primary', sha256: primary.sha256, size: primary.size, pageCount: content.stats.leftPages }),
    Object.freeze({ role: 'revision', sha256: revision.sha256, size: revision.size, pageCount: content.stats.rightPages }),
  ]), entries: Object.freeze(records), localOnly: true, sourcePdfsIncluded: false });
  const manifestBytes = Buffer.from(canonicalComparisonJson(manifest), 'utf8'); entries.push(['manifest.json', manifestBytes]);
  const bytes = writeStoredZip(entries, COMPARISON_PACKAGE_LIMITS); validateComparisonPackage(bytes, primary.sha256, revision.sha256);
  return Object.freeze({ bytes, manifest, sha256: digest(bytes) });
}

export function validateComparisonPackage(bytes, primaryDigest, revisionDigest) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > COMPARISON_PACKAGE_LIMITS.maximumArchiveBytes) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package ZIP is missing or oversized.');
  const entries = readZipEntries(bytes, { maximumEntries: COMPARISON_PACKAGE_LIMITS.maximumEntries, maximumEntryBytes: COMPARISON_PACKAGE_LIMITS.maximumEntryBytes, maximumExpandedBytes: COMPARISON_PACKAGE_LIMITS.maximumArchiveBytes, maximumCompressionRatio: 1 });
  const manifestBytes = entries.get('manifest.json'); if (!manifestBytes) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package manifest is missing.');
  let manifest; try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch (error) { fail('COMPARISON_PACKAGE_INVALID', 'Comparison package manifest is invalid JSON.', 502, error); }
  if (canonicalComparisonJson(manifest) !== manifestBytes.toString('utf8') || Object.keys(manifest).sort().join(',') !== 'entries,kind,localOnly,schemaVersion,sourcePdfsIncluded,sources'
    || manifest.schemaVersion !== COMPARISON_PACKAGE_SCHEMA_VERSION || manifest.kind !== 'local-comparison-package' || manifest.localOnly !== true || manifest.sourcePdfsIncluded !== false) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package manifest is invalid or noncanonical.');
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== 2
    || manifest.sources.some((source) => !source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).sort().join(',') !== 'pageCount,role,sha256,size' || !Number.isSafeInteger(source.size) || source.size < 1 || !Number.isSafeInteger(source.pageCount) || source.pageCount < 0 || source.pageCount > COMPARISON_PACKAGE_LIMITS.maximumPages)
    || manifest.sources[0]?.role !== 'primary' || manifest.sources[0]?.sha256 !== primaryDigest || manifest.sources[1]?.role !== 'revision' || manifest.sources[1]?.sha256 !== revisionDigest) fail('COMPARISON_SOURCE_MISMATCH', 'Comparison package source bindings do not match.', 409);
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== entries.size - 1) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package entry inventory is incomplete.');
  const expected = new Set(['manifest.json']);
  for (const [index, record] of manifest.entries.entries()) {
    if (!record || Object.keys(record).sort().join(',') !== 'mediaType,path,sha256,size' || typeof record.path !== 'string' || expected.has(record.path)
      || (index > 0 && manifest.entries[index - 1].path.localeCompare(record.path) >= 0)
      || !['application/json', 'image/png'].includes(record.mediaType) || (record.path.startsWith('receipts/') !== (record.mediaType === 'application/json'))
      || !Number.isSafeInteger(record.size) || record.size < 1 || !SHA256.test(record.sha256)) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package entry record is invalid.');
    const entry = entries.get(record.path); if (!entry || entry.length !== record.size || digest(entry) !== record.sha256) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package entry digest does not match its manifest.'); expected.add(record.path);
  }
  const paths = [...entries.keys()];
  if (!expected.has('receipts/content.json') || (paths.some((path) => path.startsWith('diff/')) && !expected.has('receipts/visual.json'))
    || expected.size !== entries.size || paths.some((path) => !expected.has(path))) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package contains an unmanifested or incoherent entry set.');
  const rebuilt = writeStoredZip([...entries.entries()], COMPARISON_PACKAGE_LIMITS);
  if (!rebuilt.equals(bytes)) fail('COMPARISON_PACKAGE_INVALID', 'Comparison package ZIP is not the exact deterministic stored representation.');
  return Object.freeze({ manifest, entries });
}
