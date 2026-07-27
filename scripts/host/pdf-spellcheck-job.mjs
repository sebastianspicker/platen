import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import {
  PDF_SPELLCHECK_PROFILE,
  normalizePdfSpellcheckRequest,
} from './pdf-spellcheck-contract.mjs';
import {
  buildPdfSpellcheckReport,
  snapshotPdfSpellcheckReport,
} from './pdf-spellcheck-report.mjs';

const MAX_JOB_MS = 120_000;
const MAX_PAGES = 1_000;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const CORE = Object.freeze({ buildPdfSpellcheckReport });

function safeExtractedText(value) {
  return typeof value === 'string' && value.normalize('NFC') === value
    && [...value].every((point) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(point)
      || '\t\n\f'.includes(point));
}

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function inspectPageCount(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(value, 'pageCount');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error();
    }
    const count = descriptor.value;
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PAGES) {
      throw host('PDF_SPELLCHECK_PAGE_LIMIT', 'The inspected PDF page count exceeds the bounded spellcheck limit.', 422);
    }
    return count;
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw host('PDF_SPELLCHECK_ENGINE_INVALID', 'PDF inspection returned an invalid page count.', 502);
  }
}

function records(value, pageCount) {
  try {
    if (!Array.isArray(value) || nodeTypes.isProxy(value)
      || value.length !== pageCount || value.length > MAX_PAGES) {
      throw new Error();
    }
    const output = [];
    let previous = 0;
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new Error();
      }
      const entry = descriptor.value;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.getPrototypeOf(entry) !== Object.prototype) throw new Error();
      const fields = Object.getOwnPropertyDescriptors(entry);
      if (Reflect.ownKeys(fields).length !== 2 || !Object.hasOwn(fields, 'page')
        || !Object.hasOwn(fields, 'text')
        || Object.values(fields).some((field) => !Object.hasOwn(field, 'value')
          || field.enumerable !== true)) throw new Error();
      const page = fields.page.value;
      const text = fields.text.value;
      if (!Number.isSafeInteger(page) || page < 1 || page <= previous
        || !safeExtractedText(text)) throw new Error();
      previous = page;
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_TEXT_BYTES) {
        throw host('PDF_SPELLCHECK_TEXT_LIMIT', 'Extracted text exceeded the bounded spellcheck limit.', 422);
      }
      output.push(Object.freeze({ page, text }));
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw host('PDF_SPELLCHECK_ENGINE_INVALID', 'Text extraction returned an invalid page inventory.', 502);
  }
}

export async function runPdfSpellcheckJob({
  store,
  inspection,
  request,
  core = CORE,
  documentId,
  signal,
}) {
  const normalized = normalizePdfSpellcheckRequest(request);
  const deadline = createDeadline(signal, MAX_JOB_MS);
  try {
    await store.verifySource(documentId);
    if (deadline.signal.aborted) throw deadline.signal.reason ?? new Error('Spellcheck cancelled.');
    const inspected = await inspection.inspect(documentId, { signal: deadline.signal });
    const pageCount = inspectPageCount(inspected);
    if (normalized.pages?.some((page) => page > pageCount)) {
      throw host('PDF_SPELLCHECK_PAGE_LIMIT', 'Spellcheck page selection exceeds the inspected PDF.', 422);
    }
    const extracted = await inspection.extractText(documentId, pageCount, {
      signal: deadline.signal,
    });
    const bounded = records(extracted, pageCount);
    if (deadline.timedOut) throw host('PDF_SPELLCHECK_TIMEOUT', 'Spellcheck exceeded its two-minute deadline.', 504);
    const selected = normalized.pages ? new Set(normalized.pages) : null;
    const pages = Object.freeze(bounded.filter((entry) => !selected || selected.has(entry.page)));
    const expected = buildPdfSpellcheckReport({ request: normalized, pages });
    const report = core.buildPdfSpellcheckReport({ request: normalized, pages });
    const result = snapshotPdfSpellcheckReport(report);
    if (!isDeepStrictEqual(result, expected)) {
      throw host('PDF_SPELLCHECK_OUTPUT_INVALID', 'Spellcheck evidence did not match the trusted bounded extraction.', 502);
    }
    await store.verifySource(documentId);
    if (deadline.signal.aborted) throw deadline.signal.reason ?? new Error('Spellcheck cancelled.');
    return result;
  } finally {
    deadline.dispose();
  }
}

export { PDF_SPELLCHECK_PROFILE };
