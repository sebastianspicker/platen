import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
import { validateComparisonPng } from './local-host-comparison-png-validation.js';
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_PAGES = 200;
const MAX_PAIRS = 8;
const MAX_TOKENS = MAX_PAGES * 20_000;
const MAX_PIXELS = 4_194_304;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const OVERLAY_DPI = 72;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MODES = ['content', 'pixel', 'annotations', 'cross-format', 'overlay', 'side-by-side'];
const PROFILE = 'local-comparison-package-v1';
const MEDIA_TYPE = 'application/vnd.platen.comparison-package+zip';
function descriptors(value) {
  try { return !value || typeof value !== 'object' ? null : Object.getOwnPropertyDescriptors(value); } catch { return null; }
}
function plainData(value, keys = null) {
  const fields = descriptors(value);
  if (!fields) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  } catch { return null; }
  const own = Reflect.ownKeys(fields);
  if (own.some((key) => typeof key !== 'string')) return null;
  const names = Object.keys(fields);
  if (keys && (names.length !== keys.length || names.some((key) => !keys.includes(key)))) return null;
  if (names.some((key) => !Object.hasOwn(fields[key], 'value') || fields[key].enumerable !== true)) return null;
  try { structuredClone(value); } catch { return null; }
  return fields;
}
function values(value, keys = null) {
  const fields = plainData(value, keys);
  return fields && Object.fromEntries(Object.keys(fields).map((key) => [key, fields[key].value]));
}
function denseArray(value, maximum = MAX_PAGES) {
  const fields = descriptors(value);
  if (!fields || !Array.isArray(value)) return null;
  const lengthValue = fields.length?.value;
  if (!fields.length || !Object.hasOwn(fields.length, 'value') || !Number.isSafeInteger(lengthValue)
    || lengthValue > maximum || lengthValue < 0) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
  } catch { return null; }
  const own = Reflect.ownKeys(fields);
  const length = fields.length;
  if (!length || Object.hasOwn(length, 'value') === false || length.enumerable !== false
    || length.get || length.set || own.length !== lengthValue + 1) return null;
  for (let index = 0; index < lengthValue; index += 1) {
    const descriptor = fields[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
  }
  if (own.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)))) return null;
  try { structuredClone(value); } catch { return null; }
  return Array.from({ length: lengthValue }, (_, index) => fields[String(index)].value);
}
function exactOptions(value, keys) { return values(value, keys); }
function validSignalOptions(value) {
  const fields = plainData(value);
  if (!fields) return null;
  const keys = Object.keys(fields);
  if (keys.some((key) => key !== 'signal')) return null;
  const signal = fields.signal?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal)) return null;
  return signal;
}
function validId(value) { return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value); }
function validPairIds(primary, secondary) { return validId(primary) && validId(secondary) && primary !== secondary; }
function boundedPage(value) { return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGES; }
function boundedDpi(value) { return Number.isSafeInteger(value) && value >= 36 && value <= 240; }
function validPages(value) {
  const pages = denseArray(value, MAX_PAGES);
  return !pages || pages.length < 1 || pages.some((page) => !boundedPage(page))
    || new Set(pages).size !== pages.length ? null : pages;
}
function requestOptions(mode, input) {
  if (input === null) return null;
  const options = input === undefined ? {} : input;
  if (mode === 'content' || mode === 'annotations' || mode === 'cross-format') {
    return exactOptions(options, []);
  }
  if (mode === 'pixel') {
    const fields = plainData(options);
    if (!fields || Object.keys(fields).some((key) => !['pages', 'dpi'].includes(key))) return null;
    const result = {};
    if (Object.hasOwn(fields, 'pages')) {
      result.pages = validPages(fields.pages.value);
      if (!result.pages) return null;
    }
    if (Object.hasOwn(fields, 'dpi')) {
      result.dpi = fields.dpi.value;
      if (!boundedDpi(result.dpi)) return null;
    }
    return result;
  }
  if (mode === 'overlay') {
    const fields = plainData(options);
    if (!fields || Object.keys(fields).some((key) => !['page', 'opacity'].includes(key))) return null;
    const page = fields.page?.value ?? 1; const opacity = fields.opacity?.value ?? 0.5;
    if (!boundedPage(page) || typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity <= 0 || opacity >= 1) return null;
    return { page, opacity };
  }
  if (mode === 'side-by-side') {
    const fields = plainData(options);
    if (!fields || Object.keys(fields).some((key) => key !== 'page')) return null;
    const page = fields.page?.value ?? 1;
    return boundedPage(page) ? { page } : null;
  }
  return null;
}
function snapshot(value, state = { active: new Set(), items: 0 }, depth = 0) {
  state.items += 1;
  if (state.items > 250_000 || depth > 12) throw new TypeError('Comparison report is too large.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Comparison report contains a non-finite number.');
  if (typeof value === 'number') return value;
  const fields = descriptors(value);
  if (!fields || state.active.has(value)) throw new TypeError('Comparison report contains hostile data.');
  state.active.add(value);
  let result;
  if (Array.isArray(value)) {
    const entries = denseArray(value, 250_000);
    if (!entries) throw new TypeError('Comparison report contains an invalid array.');
    result = Object.freeze(entries.map((entry) => snapshot(entry, state, depth + 1)));
  } else {
    const plain = plainData(value);
    if (!plain) throw new TypeError('Comparison report contains a non-plain object.');
    result = Object.create(null);
    for (const key of Object.keys(plain)) result[key] = snapshot(plain[key].value, state, depth + 1);
    result = Object.freeze(result);
  }
  state.active.delete(value);
  return result;
}
function failResult() { throw new TypeError('Comparison result is invalid.'); }
function count(value, maximum) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function reportInputs(value, primaryId, secondaryId) {
  const entries = denseArray(value, 2);
  if (!entries || entries.length !== 2) return null;
  const result = entries.map((entry, index) => {
    const fields = values(entry, ['documentId', 'sha256', 'role']);
    const expectedId = index === 0 ? primaryId : secondaryId;
    const expectedRole = index === 0 ? 'primary' : 'secondary';
    if (!fields || fields.documentId !== expectedId || fields.role !== expectedRole
      || typeof fields.sha256 !== 'string' || !SHA256.test(fields.sha256)) return null;
    return Object.freeze({ documentId: fields.documentId, sha256: fields.sha256, role: fields.role });
  });
  return result.every(Boolean) ? Object.freeze(result) : null;
}
function contentReport(report, primaryId, secondaryId) {
  const fields = values(report, ['kind', 'inputs', 'stats', 'pages']);
  if (!fields || fields.kind !== 'content') return null;
  const inputs = reportInputs(fields.inputs, primaryId, secondaryId);
  const pages = denseArray(fields.pages, MAX_PAGES);
  const stats = values(fields.stats, ['added', 'deleted', 'unchanged', 'changed', 'leftPages', 'rightPages']);
  if (!inputs || !pages || pages.length < 1 || !stats
    || !['added', 'deleted', 'unchanged', 'changed'].every((key) => count(stats[key], MAX_TOKENS * 2))
    || !count(stats.leftPages, MAX_PAGES) || !count(stats.rightPages, MAX_PAGES)) return null;
  const stablePages = pages.map((page, index) => {
    const p = values(page, ['page', 'leftPresent', 'rightPresent', 'runs', 'stats']);
    const runs = denseArray(p?.runs, 40_000);
    const ps = values(p?.stats, ['added', 'deleted', 'unchanged']);
    if (!p || !runs || !ps || p.page !== index + 1 || typeof p.leftPresent !== 'boolean' || typeof p.rightPresent !== 'boolean'
      || !['added', 'deleted', 'unchanged'].every((key) => count(ps[key], 20_000))) return null;
    const stableRuns = runs.map((run) => {
      const r = values(run, ['kind', 'text', 'count']);
      return r && ['added', 'deleted', 'unchanged'].includes(r.kind) && typeof r.text === 'string'
        && r.text.length <= 1_000_000 && count(r.count, 20_000) && r.count > 0
        ? Object.freeze({ kind: r.kind, text: r.text, count: r.count }) : null;
    });
    if (stableRuns.some((run) => !run)) return null;
    for (const kind of ['added', 'deleted', 'unchanged']) {
      if (stableRuns.filter((run) => run.kind === kind).reduce((sum, run) => sum + run.count, 0) !== ps[kind]) return null;
    }
    return Object.freeze({ page: p.page, leftPresent: p.leftPresent, rightPresent: p.rightPresent, runs: Object.freeze(stableRuns), stats: Object.freeze(ps) });
  });
  if (stablePages.some((page) => !page)) return null;
  for (const key of ['added', 'deleted', 'unchanged']) if (stablePages.reduce((sum, page) => sum + page.stats[key], 0) !== stats[key]) return null;
  if (stats.changed !== stats.added + stats.deleted || stats.leftPages !== stablePages.filter((page) => page.leftPresent).length || stats.rightPages !== stablePages.filter((page) => page.rightPresent).length) return null;
  return Object.freeze({ kind: 'content', inputs, stats: Object.freeze(stats), pages: Object.freeze(stablePages) });
}
function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_BYTES * 2 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const final = padding ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(value[value.length - padding - 1]) : 0;
  if (final < 0 || (padding === 2 && (final & 15) !== 0) || (padding === 1 && (final & 3) !== 0)) return null;
  const output = new Uint8Array((value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0));
  let cursor = 0; for (let index = 0; index < value.length; index += 4) {
    const chars = value.slice(index, index + 4); const nums = [...chars].map((char) => char === '=' ? 0 : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(char));
    if (nums.some((number) => number < 0)) return null;
    const number = (nums[0] << 18) | (nums[1] << 12) | (nums[2] << 6) | nums[3];
    if (cursor < output.length) output[cursor++] = (number >> 16) & 255;
    if (cursor < output.length) output[cursor++] = (number >> 8) & 255;
    if (cursor < output.length) output[cursor++] = number & 255;
  }
  return output;
}
function sha256(bytes) {
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const bitLength = bytes.length * 8; const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6); padded.set(bytes); padded[bytes.length] = 128;
  for (let index = 0; index < 8; index += 1) padded[padded.length - 1 - index] = Math.floor(bitLength / 2 ** (index * 8)) & 255;
  let [a,b,c,d,e,f,g,h] = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64); for (let index = 0; index < 16; index += 1) words[index] = (padded[offset + index * 4] << 24) | (padded[offset + index * 4 + 1] << 16) | (padded[offset + index * 4 + 2] << 8) | padded[offset + index * 4 + 3];
    for (let index = 16; index < 64; index += 1) { const x = words[index - 15]; const y = words[index - 2]; const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3); const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10); words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0; }
    let [aa,bb,cc,dd,ee,ff,gg,hh] = [a,b,c,d,e,f,g,h];
    for (let index = 0; index < 64; index += 1) { const S1 = ((ee >>> 6) | (ee << 26)) ^ ((ee >>> 11) | (ee << 21)) ^ ((ee >>> 25) | (ee << 7)); const ch = (ee & ff) ^ (~ee & gg); const t1 = (hh + S1 + ch + constants[index] + words[index]) >>> 0; const S0 = ((aa >>> 2) | (aa << 30)) ^ ((aa >>> 13) | (aa << 19)) ^ ((aa >>> 22) | (aa << 10)); const maj = (aa & bb) ^ (aa & cc) ^ (bb & cc); const t2 = (S0 + maj) >>> 0; [hh,gg,ff,ee,dd,cc,bb,aa] = [gg,ff,ee,(dd + t1) >>> 0,cc,bb,aa,(t1 + t2) >>> 0]; }
    [a,b,c,d,e,f,g,h] = [(a+aa)>>>0,(b+bb)>>>0,(c+cc)>>>0,(d+dd)>>>0,(e+ee)>>>0,(f+ff)>>>0,(g+gg)>>>0,(h+hh)>>>0];
  }
  return [a,b,c,d,e,f,g,h].map((word) => word.toString(16).padStart(8, '0')).join('');
}
function pixelReport(report, primaryId, secondaryId, expectedOptions = {}) {
  const fields = values(report, ['kind', 'inputs', 'dpi', 'stats', 'pages']);
  if (!fields || fields.kind !== 'pixel' || !boundedDpi(fields.dpi) || (expectedOptions.dpi !== undefined && fields.dpi !== expectedOptions.dpi)) return null;
  const inputs = reportInputs(fields.inputs, primaryId, secondaryId); const pages = denseArray(fields.pages, MAX_PAGES); const stats = values(fields.stats, ['comparedPages', 'changedPixels', 'comparedPixels']);
  if (!inputs || !pages || pages.length < 1 || !stats || !count(stats.comparedPages, MAX_PAGES) || !count(stats.changedPixels, MAX_PIXELS * MAX_PAGES) || !count(stats.comparedPixels, MAX_PIXELS * MAX_PAGES)) return null;
  const seen = new Set(); let compared = 0; let changed = 0; let pixels = 0;
  const stablePages = pages.map((page) => {
    const p = values(page); if (!p || !boundedPage(p.page) || seen.has(p.page)) return null; seen.add(p.page);
    if (p.status === 'unpaired-page') {
      const u = values(page, ['page', 'status', 'leftPresent', 'rightPresent']);
      return u && typeof u.leftPresent === 'boolean' && typeof u.rightPresent === 'boolean' ? Object.freeze(u) : null;
    }
    const pFields = values(page, ['page', 'status', 'width', 'height', 'left', 'right', 'changedPixels', 'comparedPixels', 'dimensionMismatch', 'meanChannelDelta', 'maximumChannelDelta', 'differenceImage']);
    if (!pFields || pFields.status !== 'compared' || !Number.isSafeInteger(pFields.width) || !Number.isSafeInteger(pFields.height) || pFields.width < 1 || pFields.height < 1 || pFields.width > 8192 || pFields.height > 8192 || !count(pFields.comparedPixels, MAX_PIXELS) || !count(pFields.changedPixels, MAX_PIXELS) || pFields.changedPixels > pFields.comparedPixels || typeof pFields.dimensionMismatch !== 'boolean' || typeof pFields.meanChannelDelta !== 'number' || !Number.isFinite(pFields.meanChannelDelta) || pFields.meanChannelDelta < 0 || pFields.meanChannelDelta > 255 || typeof pFields.maximumChannelDelta !== 'number' || !Number.isFinite(pFields.maximumChannelDelta) || pFields.maximumChannelDelta < 0 || pFields.maximumChannelDelta > 255) return null;
    const left = values(pFields.left, ['width', 'height']); const right = values(pFields.right, ['width', 'height']); const image = values(pFields.differenceImage, ['format', 'encoding', 'sha256', 'data']);
    if (!left || !right || !Number.isSafeInteger(left.width) || !Number.isSafeInteger(left.height) || !Number.isSafeInteger(right.width) || !Number.isSafeInteger(right.height) || left.width < 1 || left.height < 1 || right.width < 1 || right.height < 1 || !image || image.format !== 'image/png' || image.encoding !== 'base64' || typeof image.sha256 !== 'string' || !SHA256.test(image.sha256)) return null;
    const bytes = decodeBase64(image.data); if (!bytes || bytes.length < 33 || bytes.length > MAX_IMAGE_BYTES || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null;
    const width = bytes[16] * 2 ** 24 + bytes[17] * 2 ** 16 + bytes[18] * 256 + bytes[19]; const height = bytes[20] * 2 ** 24 + bytes[21] * 2 ** 16 + bytes[22] * 256 + bytes[23];
    if (width !== pFields.width || height !== pFields.height || sha256(bytes) !== image.sha256) return null;
    compared += 1; changed += pFields.changedPixels; pixels += pFields.comparedPixels;
    return Object.freeze({ ...pFields, left: Object.freeze(left), right: Object.freeze(right), differenceImage: Object.freeze(image) });
  });
  if (stablePages.some((page) => !page) || compared !== stats.comparedPages || changed !== stats.changedPixels || pixels !== stats.comparedPixels) return null;
  return Object.freeze({ kind: 'pixel', inputs, dpi: fields.dpi, stats: Object.freeze(stats), pages: Object.freeze(stablePages) });
}
function annotationsReport(report, primaryId, secondaryId) {
  const fields = values(report, ['kind', 'inputs', 'stats', 'added', 'deleted', 'changed', 'unchanged']); if (!fields || fields.kind !== 'annotations') return null;
  const inputs = reportInputs(fields.inputs, primaryId, secondaryId); const added = denseArray(fields.added, 200_000); const deleted = denseArray(fields.deleted, 200_000); const changed = denseArray(fields.changed, 200_000); const unchanged = denseArray(fields.unchanged, 200_000); const stats = values(fields.stats, ['added', 'deleted', 'changed', 'unchanged']);
  if (!inputs || !added || !deleted || !changed || !unchanged || !stats || stats.added !== added.length || stats.deleted !== deleted.length || stats.changed !== changed.length || stats.unchanged !== unchanged.length || !['added', 'deleted', 'changed', 'unchanged'].every((key) => count(stats[key], 200_000))) return null;
  try { return Object.freeze({ kind: 'annotations', inputs, stats: Object.freeze(stats), added: snapshot(added), deleted: snapshot(deleted), changed: snapshot(changed), unchanged: snapshot(unchanged) }); } catch { return null; }
}
async function overlayReport(report, primaryId, secondaryId, request) {
  const fields = values(report, ['kind', 'inputs', 'page', 'dpi', 'opacity', 'semantics', 'image', 'validation']);
  if (!fields || fields.kind !== 'overlay' || !reportInputs(fields.inputs, primaryId, secondaryId)
    || fields.page !== request.page || fields.dpi !== OVERLAY_DPI || fields.opacity !== request.opacity
    || fields.semantics !== 'primary-red-secondary-cyan') return null;
  const image = values(fields.image, ['mediaType', 'encoding', 'sha256', 'size', 'data']);
  if (!image || image.mediaType !== 'image/png' || image.encoding !== 'base64'
    || !SHA256.test(image.sha256) || !Number.isSafeInteger(image.size)
    || image.size < 57 || image.size > MAX_IMAGE_BYTES) return null;
  const bytes = decodeBase64(image.data);
  const geometry = bytes && await validateComparisonPng(bytes, MAX_IMAGE_BYTES, MAX_PIXELS);
  if (!geometry || bytes.length !== image.size || sha256(bytes) !== image.sha256) return null;
  const validation = values(fields.validation, ['decoded', 'width', 'height', 'outputSha256', 'sourceReread']);
  if (!validation || validation.decoded !== true || validation.width !== geometry.width
    || validation.height !== geometry.height || validation.outputSha256 !== image.sha256
    || validation.sourceReread !== true) return null;
  return Object.freeze({
    kind: 'overlay',
    inputs: reportInputs(fields.inputs, primaryId, secondaryId),
    page: fields.page,
    dpi: fields.dpi,
    opacity: fields.opacity,
    semantics: fields.semantics,
    image: Object.freeze(image),
    validation: Object.freeze(validation),
  });
}
async function sideBySideReport(report, primaryId, secondaryId, request) {
  const fields = values(report, ['kind', 'inputs', 'page', 'dpi', 'semantics', 'panes', 'validation']);
  if (!fields || fields.kind !== 'side-by-side' || fields.page !== request.page
    || fields.dpi !== OVERLAY_DPI || fields.semantics !== 'primary-left-secondary-right') return null;
  const inputs = reportInputs(fields.inputs, primaryId, secondaryId);
  const panes = denseArray(fields.panes, 2);
  const validation = values(fields.validation, ['sourceReread']);
  if (!inputs || !panes || panes.length !== 2 || validation?.sourceReread !== true) return null;
  const stablePanes = await Promise.all(panes.map(async (pane, index) => {
    const expectedRole = index === 0 ? 'primary' : 'secondary';
    const value = values(pane, ['role', 'mediaType', 'encoding', 'sha256', 'size', 'width', 'height', 'data']);
    if (!value || value.role !== expectedRole || value.mediaType !== 'image/png'
      || value.encoding !== 'base64' || !SHA256.test(value.sha256)
      || !Number.isSafeInteger(value.size) || value.size < 57 || value.size > MAX_IMAGE_BYTES
      || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) return null;
    const bytes = decodeBase64(value.data);
    const geometry = bytes && await validateComparisonPng(bytes, MAX_IMAGE_BYTES, MAX_PIXELS);
    if (!geometry || bytes.length !== value.size || sha256(bytes) !== value.sha256
      || geometry.width !== value.width || geometry.height !== value.height) return null;
    return Object.freeze(value);
  }));
  if (stablePanes.some((pane) => !pane)) return null;
  return Object.freeze({
    kind: 'side-by-side', inputs, page: fields.page, dpi: fields.dpi,
    semantics: fields.semantics, panes: Object.freeze(stablePanes),
    validation: Object.freeze(validation),
  });
}
function crossFormatReport(report, primaryId, secondaryId) {
  const fields = values(report, ['kind', 'conversionPerformed', 'semantics', 'content']);
  const content = fields && contentReport(fields.content, primaryId, secondaryId);
  return fields && fields.kind === 'cross-format' && fields.conversionPerformed === false
    && typeof fields.semantics === 'string' && fields.semantics.length <= 2_048 && content
    ? Object.freeze({ kind: 'cross-format', conversionPerformed: false, semantics: fields.semantics, content })
    : null;
}
async function directReport(report, primaryId, secondaryId, mode, request) {
  const validators = {
    content: () => contentReport(report, primaryId, secondaryId),
    pixel: () => pixelReport(report, primaryId, secondaryId, request),
    annotations: () => annotationsReport(report, primaryId, secondaryId),
    'cross-format': () => crossFormatReport(report, primaryId, secondaryId),
    overlay: () => overlayReport(report, primaryId, secondaryId, request),
    'side-by-side': () => sideBySideReport(report, primaryId, secondaryId, request),
  };
  const value = await validators[mode]();
  if (!value) failResult();
  return value;
}
function batchPair(value, mode) {
  const fields = plainData(value); if (!fields || !Object.hasOwn(fields, 'primaryDocumentId') || !Object.hasOwn(fields, 'secondaryDocumentId')) return null;
  const keys = Object.keys(fields); const allowed = mode === 'pixel' ? ['primaryDocumentId', 'secondaryDocumentId', 'pages', 'dpi'] : ['primaryDocumentId', 'secondaryDocumentId'];
  if (keys.some((key) => !allowed.includes(key)) || !validPairIds(fields.primaryDocumentId.value, fields.secondaryDocumentId.value)) return null;
  const result = { primaryDocumentId: fields.primaryDocumentId.value, secondaryDocumentId: fields.secondaryDocumentId.value };
  if (mode === 'pixel' && Object.hasOwn(fields, 'pages')) { result.pages = validPages(fields.pages.value); if (!result.pages) return null; }
  if (mode === 'pixel' && Object.hasOwn(fields, 'dpi')) { result.dpi = fields.dpi.value; if (!boundedDpi(result.dpi)) return null; }
  return result;
}
function resultFromBody(body) {
  const fields = plainData(body, ['report']); if (!fields) failResult(); return fields.report.value;
}
function validPackage(body, context) {
  const result = body?.result; const artifact = result?.artifact; const operation = artifact?.operation; const inputs = operation?.inputs;
  const validInputs = Array.isArray(inputs) && inputs.length === 2
    && exactPackage(inputs[0], ['documentId', 'sha256', 'role']) && exactPackage(inputs[1], ['documentId', 'sha256', 'role'])
    && inputs[0].documentId === context.primaryId && inputs[0].sha256 === context.request.primarySha256 && inputs[0].role === 'primary'
    && inputs[1].documentId === context.request.revisionDocumentId && inputs[1].sha256 === context.request.revisionSha256 && inputs[1].role === 'revision';
  const valid = exactPackage(result, ['kind', 'schemaVersion', 'sourceDigests', 'includeVisual', 'dpi', 'receiptDigests', 'artifact', 'evidence', 'limitations'])
    && result.kind === 'comparison-package' && result.schemaVersion === 1
    && exactPackage(result.sourceDigests, ['primary', 'revision']) && result.sourceDigests.primary === context.request.primarySha256 && result.sourceDigests.revision === context.request.revisionSha256
    && result.includeVisual === context.request.includeVisual && result.dpi === (context.request.includeVisual ? context.request.dpi : null)
    && exactPackage(result.receiptDigests, ['content', 'visual']) && SHA256.test(result.receiptDigests.content ?? '') && (result.receiptDigests.visual === null || SHA256.test(result.receiptDigests.visual ?? ''))
    && exactPackage(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.documentId === context.primaryId && artifact.mediaType === MEDIA_TYPE && artifact.displayName.endsWith('.pdfcompare')
    && Number.isSafeInteger(artifact.size) && artifact.size > 0 && SHA256.test(artifact.sha256 ?? '')
    && operation?.type === 'comparison-package' && validInputs && operation.validation?.passed === true && operation.validation.outputSha256 === artifact.sha256
    && result.evidence?.localOnly === true && result.evidence.exactlyTwoSources === true && result.evidence.sourcePdfsIncluded === false && result.evidence.deterministicStoredZip === true
    && Array.isArray(result.limitations) && result.limitations.length >= 1 && result.limitations.every((entry) => typeof entry === 'string' && entry.length >= 1 && entry.length <= 1_024);
  if (!valid) throw new TypeError('Comparison package result is invalid.');
  return Object.freeze(result);
}
function exactPackage(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}
/** Document-pair and bounded batch-comparison transport. */
export function createComparisonEndpoints({ json }) {
  function optionsForCall(value) { if (value === null) throw new TypeError('Comparison transport options are invalid.'); const signal = validSignalOptions(value === undefined ? {} : value); if (signal === null) throw new TypeError('Comparison transport options are invalid.'); return signal; }
  function compareDocuments(documentId, secondaryDocumentId, mode, options = {}, callOptions = {}) {
    if (!validPairIds(documentId, secondaryDocumentId) || !MODES.includes(mode)) throw new TypeError('Comparison request is invalid.');
    const normalized = requestOptions(mode, options); if (!normalized) throw new TypeError('Comparison request is invalid.');
    const signal = optionsForCall(callOptions);
    return postJson(json, documentEndpointPath(documentId, '/compare'), { secondaryDocumentId, mode, options: normalized }, signal)
      .then((body) => directReport(resultFromBody(body), documentId, secondaryDocumentId, mode, normalized));
  }
  function compareBatch(pairs, mode = 'content', callOptions = {}) {
    if (!['content', 'pixel'].includes(mode)) throw new TypeError('Batch comparison mode is invalid.');
    const entries = denseArray(pairs, MAX_PAIRS); if (!entries || entries.length < 1 || entries.length > MAX_PAIRS) throw new TypeError('Batch comparison pairs are invalid.');
    const normalized = entries.map((pair) => batchPair(pair, mode)); if (normalized.some((pair) => !pair)) throw new TypeError('Batch comparison pairs are invalid.');
    const signal = optionsForCall(callOptions);
    return postJson(json, '/api/comparisons/batch', { pairs: normalized, mode }, signal).then(async (body) => {
      const report = resultFromBody(body); const fields = values(report, ['kind', 'mode', 'reports']); const reports = fields && denseArray(fields.reports, MAX_PAIRS);
      if (!fields || fields.kind !== 'batch' || fields.mode !== mode || !reports || reports.length !== normalized.length) failResult();
      const stable = await Promise.all(reports.map((nested, index) => directReport(nested, normalized[index].primaryDocumentId, normalized[index].secondaryDocumentId, mode, normalized[index])));
      return Object.freeze({ kind: 'batch', mode, reports: Object.freeze(stable) });
    });
  }
  function createComparisonPackage(primaryDocumentId, request, { signal } = {}) {
    const keys = request?.includeVisual === true ? ['profile', 'revisionDocumentId', 'primarySha256', 'revisionSha256', 'includeVisual', 'dpi'] : ['profile', 'revisionDocumentId', 'primarySha256', 'revisionSha256', 'includeVisual'];
    if (!OPAQUE_ID_PATTERN.test(primaryDocumentId ?? '') || !exactPackage(request, keys) || request.profile !== PROFILE
      || !OPAQUE_ID_PATTERN.test(request.revisionDocumentId ?? '') || request.revisionDocumentId === primaryDocumentId
      || !SHA256.test(request.primarySha256 ?? '') || !SHA256.test(request.revisionSha256 ?? '') || typeof request.includeVisual !== 'boolean'
      || (request.includeVisual && (!Number.isSafeInteger(request.dpi) || request.dpi < 36 || request.dpi > 240))
      || (signal !== undefined && !(signal instanceof AbortSignal))) throw new TypeError('Comparison package request is invalid.');
    return postJson(json, documentEndpointPath(primaryDocumentId, '/comparison-package'), request, signal)
      .then((body) => validPackage(body, { primaryId: primaryDocumentId, request }));
  }
  return { compareDocuments, compareBatch, createComparisonPackage };
}
