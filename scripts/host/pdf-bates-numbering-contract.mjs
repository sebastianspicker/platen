export const PDF_BATES_NUMBERING_PROFILE = 'local-pdf-bates-numbering-v1';
const MAX_PAGES = 500;
const MAX_COORDINATE = 1_000_000;
const MAX_TEXT_BYTES = 256;
function invalid(message = 'The Bates-numbering request is invalid.') { const e = new Error(message);
e.code = 'INVALID_PDF_BATES_NUMBERING';
throw e;
}
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((k) => typeof k !== 'string') || Object.keys(value).length !== keys.length || Object.keys(value).some((k) => !keys.includes(k)) || Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !Object.hasOwn(d, 'value') || d.enumerable !== true)) invalid();
return value;
}
function text(value) { if (typeof value !== 'string' || value.length < 0 || [...value].length > 64 || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES || value !== value.normalize('NFC') || !/^[\x20-\x7E]*$/u.test(value)) invalid('prefix and suffix must be bounded printable ASCII text.');
return value;
}
export function normalizePdfBatesNumbering(value) { const request = exact(value, ['profile', 'sourceSha256', 'pages', 'start', 'prefix', 'suffix', 'padding', 'position', 'margin', 'fontSize']);
if (request.profile !== PDF_BATES_NUMBERING_PROFILE || typeof request.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(request.sourceSha256) || !Array.isArray(request.pages) || Object.getPrototypeOf(request.pages) !== Array.prototype || Object.getOwnPropertySymbols(request.pages).length !== 0) invalid();
const pageDescriptors = Object.getOwnPropertyDescriptors(request.pages);
const validPages = request.pages.length >= 1 && request.pages.length <= MAX_PAGES
  && Object.keys(pageDescriptors).filter((key) => key !== 'length').length === request.pages.length
  && Object.entries(pageDescriptors).filter(([key]) => key !== 'length').every(([, d]) => Object.hasOwn(d, 'value') && d.enumerable === true)
  && request.pages.every((p) => Number.isSafeInteger(p) && p >= 1 && p <= MAX_PAGES)
  && request.pages.every((p, i) => i === 0 || p > request.pages[i - 1]);
const validNumbers = Number.isSafeInteger(request.start) && request.start >= 0 && request.start <= 999_999_999
  && request.start + request.pages.length - 1 <= 999_999_999
  && Number.isSafeInteger(request.padding) && request.padding >= 1 && request.padding <= 12;
const validLayout = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'].includes(request.position)
  && typeof request.margin === 'number' && Number.isFinite(request.margin) && request.margin >= 0 && request.margin <= MAX_COORDINATE
  && typeof request.fontSize === 'number' && Number.isFinite(request.fontSize) && request.fontSize > 0 && request.fontSize <= 200;
if (!validPages || !validNumbers || !validLayout) invalid();
const prefix = text(request.prefix); const suffix = text(request.suffix); if (Buffer.byteLength(`${prefix}${request.start + request.pages.length - 1}`.padStart(request.padding + prefix.length, '0') + suffix, 'latin1') > MAX_TEXT_BYTES) invalid('The rendered Bates text exceeds its byte bound.');
return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, pages: Object.freeze([...new Set(request.pages)]), start: request.start, prefix, suffix, padding: request.padding, position: request.position, margin: request.margin, fontSize: request.fontSize });
}
