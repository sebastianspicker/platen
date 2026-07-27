export const PDF_PRINTER_MARKS_PROFILE = 'local-pdf-printer-marks-v1';
export const PRINTER_MARKS_PROFILE = PDF_PRINTER_MARKS_PROFILE;

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_PAGES = 500;

function invalid(message = 'PDF printer-marks request is invalid.') {
  const error = new Error(message); error.code = 'INVALID_PDF_PRINTER_MARKS'; return error;
}

function exactObject(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== required.length || keys.some((key) => typeof key !== 'string' || !required.includes(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw invalid();
  return descriptors;
}

export function normalizePdfPrinterMarks(value) {
  const request = exactObject(value, ['profile', 'sourceSha256', 'pages']);
  if (request.profile.value !== PDF_PRINTER_MARKS_PROFILE
    || typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) throw invalid();
  const pages = request.pages.value;
  if (!Array.isArray(pages) || Object.getPrototypeOf(pages) !== Array.prototype || pages.length < 1 || pages.length > MAX_PAGES) throw invalid();
  const normalized = [];
  let previous = 0;
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES || page <= previous) throw invalid('Printer-marks pages must be unique, strictly ascending one-based integers.');
    normalized.push(page); previous = page;
  }
  return Object.freeze({ profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: request.sourceSha256.value, pages: Object.freeze(normalized) });
}

export const normalizePrinterMarks = normalizePdfPrinterMarks;
