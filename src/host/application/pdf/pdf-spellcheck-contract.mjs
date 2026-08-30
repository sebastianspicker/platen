import { types as nodeTypes } from 'node:util';

export const PDF_SPELLCHECK_PROFILE = 'local-pdf-spellcheck-review-v1';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_PAGES = 1_000;
const MAX_DICTIONARY_TERMS = 10_000;
const MAX_TERM_CHARS = 128;
const MAX_DICTIONARY_BYTES = 512 * 1024;
const TOKEN = /^[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*$/u;

function invalid(message = 'PDF spellcheck request is invalid.') {
  const error = new Error(message); error.code = 'INVALID_PDF_SPELLCHECK'; return error;
}

function exactObject(value, required) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value);
    if (keys.length !== required.length || keys.some((key) => typeof key !== 'string' || !required.includes(key)) || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw invalid();
    return descriptors;
  } catch (error) { if (error?.code === 'INVALID_PDF_SPELLCHECK') throw error; throw invalid(); }
}

function text(value, label) {
  if (typeof value !== 'string' || value.normalize('NFC') !== value || [...value].some((point) => /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(point))) throw invalid(`${label} must be NFC text without controls.`);
  return value;
}

function normalizeDictionary(value) {
  try {
    if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > MAX_DICTIONARY_TERMS) throw invalid('The local dictionary is outside its bounded term limit.');
    const terms = new Set(); let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw invalid('The local dictionary must be a dense data-only array.');
      const term = text(descriptor.value, 'Dictionary terms');
      if ([...term].length < 1 || [...term].length > MAX_TERM_CHARS || !TOKEN.test(term)) throw invalid('Dictionary terms must be bounded words.');
      const folded = term.toLocaleLowerCase('und'); bytes += Buffer.byteLength(folded, 'utf8'); if (bytes > MAX_DICTIONARY_BYTES) throw invalid('The local dictionary exceeds its bounded UTF-8 limit.');
      terms.add(folded);
    }
    return Object.freeze([...terms].sort((left, right) => left.localeCompare(right, 'und')));
  } catch (error) { if (error?.code === 'INVALID_PDF_SPELLCHECK') throw error; throw invalid(); }
}

function normalizePages(value) {
  if (value === null) return null;
  try {
    if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > MAX_PAGES) throw invalid('Spellcheck page selection is outside its bounded limit.');
    const pages = []; let previous = 0;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw invalid('Spellcheck page selection must be a dense data-only array.');
      const page = descriptor.value; if (!Number.isSafeInteger(page) || page < 1 || page <= previous) throw invalid('Spellcheck pages must be strictly ascending positive integers.');
      previous = page; pages.push(page);
    }
    return Object.freeze(pages);
  } catch (error) { if (error?.code === 'INVALID_PDF_SPELLCHECK') throw error; throw invalid(); }
}

export function normalizePdfSpellcheckRequest(value) {
  const request = exactObject(value, ['profile', 'sourceSha256', 'dictionary', 'pages']);
  if (request.profile.value !== PDF_SPELLCHECK_PROFILE || typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) throw invalid();
  const dictionary = normalizeDictionary(request.dictionary.value); const pages = normalizePages(request.pages.value);
  return Object.freeze({ profile: PDF_SPELLCHECK_PROFILE, sourceSha256: request.sourceSha256.value, dictionary, pages });
}

export const normalizeSpellcheckRequest = normalizePdfSpellcheckRequest;
