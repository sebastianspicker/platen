import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';

const MAX_FIELDS = 100;
const MAX_DEPTH = 2;

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message) { throw failure('UNSUPPORTED_PDF_ACROFORM_VALIDATION_SOURCE', message); }
function invalid(message) { throw failure('INVALID_PDF_ACROFORM_VALIDATION', message); }
export function acroFormDigest(value) { return createHash('sha256').update(value).digest('hex'); }

export function boundedNfcText(value, label, { minimum = 1, maximum = 127 } = {}) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value !== value.normalize('NFC')
    || /[\u0000-\u001f\u007f\ufffd\p{Cf}]/u.test(value)) invalid(`${label} must be bounded NFC text.`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(index + 1); if (next < 0xdc00 || next > 0xdfff) invalid(`${label} contains an unpaired surrogate.`); index += 1; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) invalid(`${label} contains an unpaired surrogate.`);
  }
  return value;
}

export function decodedAcroFormName(value) {
  if (value?.type !== 'string') return null;
  const bytes = value.bytes;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = ''; for (let index = 2; index + 1 < bytes.length; index += 2) text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]); return text;
  }
  return bytes.toString('latin1');
}

export function decodeStrictAcroFormExportString(value) {
  if (value?.type !== 'string' || !Buffer.isBuffer(value.bytes)) unsupported('The PDF string is malformed.');
  const bytes = value.bytes;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if ((bytes.length - 2) % 2 !== 0) unsupported('The UTF-16BE PDF string has an odd payload length.');
    let text = '';
    for (let index = 2; index < bytes.length; index += 2) text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    try { boundedNfcText(text, 'PDF string', { minimum: 0, maximum: 2_000 }); } catch { unsupported('The UTF-16BE PDF string is invalid.'); }
    return text;
  }
  if (bytes.some((byte) => byte < 0x20 || byte > 0x7e)) unsupported('Only printable ASCII non-BOM PDF strings are admitted for export.');
  return bytes.toString('ascii');
}

function referenceKey(reference) { return `${reference.object}:${reference.generation}`; }
function directDictionary(structure, reference, message) {
  try { return pdfDictionary(resolvePdfObject(structure, reference).value); } catch { unsupported(message); }
}
export function inheritedAcroFormEntry(entries, parent, key) {
  let current = { entries, parent };
  for (let depth = 0; current && depth <= MAX_DEPTH; depth += 1) {
    if (current.entries?.has(key)) return current.entries.get(key);
    current = current.parent;
  }
  return undefined;
}
function fieldType(entries, parent) { return inheritedAcroFormEntry(entries, parent, 'FT'); }
function fieldName(entries, parent) { return inheritedAcroFormEntry(entries, parent, 'T'); }
function fieldFlags(entries, parent) { return inheritedAcroFormEntry(entries, parent, 'Ff')?.value ?? 0; }
function normalAppearance(entries) { const appearance = entries.get('AP'); return appearance?.type === 'dict' ? pdfDictionary(appearance).get('N') : null; }

export function inspectClassicAcroForm(sourceBytes) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 5 || sourceBytes.length > 32 * 1024 * 1024) unsupported('The source size is outside the bounded subset.');
  let structure; try { structure = parsePdfStructure(sourceBytes); } catch { unsupported('The source is not a valid classic PDF.'); }
  let catalog;
  try { catalog = pdfDictionary(resolvePdfObject(structure, structure.root).value); } catch { unsupported('The source catalog is invalid.'); }
  if (catalog.has('XFA') || catalog.has('OpenAction') || catalog.has('Names')) unsupported('Active or XFA catalog entries are not admitted.');
  const acroRef = catalog.get('AcroForm'); if (acroRef?.type !== 'ref') unsupported('An existing AcroForm is required.');
  const acro = directDictionary(structure, acroRef, 'The AcroForm is invalid.');
  if (acro.has('XFA') || acro.has('CO') || acro.has('AA')) unsupported('XFA, calculations, and additional actions are not admitted.');
  const roots = acro.get('Fields'); if (roots?.type !== 'array' || roots.values.length < 1 || roots.values.length > MAX_FIELDS) unsupported('The AcroForm field graph is outside the bounded subset.');
  const seen = new Set(); const fields = [];
  function walk(reference, parent = null, depth = 0) {
    if (depth > MAX_DEPTH || reference?.type !== 'ref') unsupported('The field graph is too deep or malformed.');
    const key = referenceKey(reference); if (seen.has(key)) unsupported('The field graph contains an alias or cycle.'); seen.add(key);
    const entries = directDictionary(structure, reference, 'A field object is invalid.');
    if (entries.has('A') || entries.has('AA') || entries.has('JS')) unsupported('Field actions and JavaScript are not admitted.');
    const kids = entries.get('Kids');
    if (kids !== undefined && (kids.type !== 'array' || kids.values.length < 1 || kids.values.length > MAX_FIELDS)) unsupported('A field Kids array is malformed.');
    if (entries.get('Subtype')?.value === 'Widget') {
      if (kids !== undefined) unsupported('Only terminal widgets are admitted.');
      const ft = fieldType(entries, parent); const name = decodedAcroFormName(fieldName(entries, parent)); const flags = fieldFlags(entries, parent);
      if (!name || !['Tx', 'Ch', 'Btn'].includes(ft?.value) || ft?.value === 'Sig') unsupported('Only named terminal text, choice, checkbox, and radio fields are admitted.');
      if (flags & 65536) unsupported('Push buttons are not admitted.');
      if (ft.value === 'Ch' && (flags & 2097152)) unsupported('Multi-select choice fields are not admitted.');
      fields.push(Object.freeze({ reference, entries, parent, parentRef: parent?.reference ?? null, name, type: ft.value, flags }));
      if (fields.length > MAX_FIELDS) unsupported('Too many terminal fields are present.');
    }
    if (kids) for (const child of kids.values) walk(child, { entries, reference, parent }, depth + 1);
  }
  for (const reference of roots.values) walk(reference);
  if (!fields.length) unsupported('The AcroForm contains no terminal fields.');
  return Object.freeze({ structure, catalog, acro, acroRef, fields: Object.freeze(fields) });
}

function exactPlain(value, keys) {
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) invalid('A plain request object is required.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || Object.keys(descriptors).some((key) => !keys.includes(key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid('The request contains unsupported properties or accessors.');
}

export function validateAcroFormValues(values, rules, { allowPattern = false } = {}) {
  exactPlain(values, Object.keys(values)); exactPlain(rules, Object.keys(rules));
  const errors = [];
  for (const name of Object.keys(values).sort()) {
    const value = values[name]; const rule = rules[name] ?? {};
    if (typeof value !== 'string' && typeof value !== 'boolean') invalid(`Value for ${name} must be a string or boolean.`);
    if (!rule || isProxy(rule) || Object.getPrototypeOf(rule) !== Object.prototype || Reflect.ownKeys(rule).some((key) => typeof key !== 'string')) invalid(`Rule for ${name} must be a plain object.`);
    const allowed = allowPattern ? ['required', 'type', 'minLength', 'maxLength', 'pattern'] : ['required', 'type', 'minLength', 'maxLength'];
    const descriptors = Object.getOwnPropertyDescriptors(rule);
    if (Object.keys(descriptors).some((key) => !allowed.includes(key)) || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid(`Rule for ${name} contains unsupported properties.`);
    if (rule.required !== undefined && typeof rule.required !== 'boolean') invalid(`required for ${name} must be boolean.`);
    if (rule.type !== undefined && !['string', 'boolean'].includes(rule.type)) invalid(`type for ${name} is invalid.`);
    for (const key of ['minLength', 'maxLength']) if (rule[key] !== undefined && (!Number.isSafeInteger(rule[key]) || rule[key] < 0 || rule[key] > 2000)) invalid(`${key} for ${name} is invalid.`);
    if (rule.minLength !== undefined && rule.maxLength !== undefined && rule.minLength > rule.maxLength) invalid(`Rule bounds for ${name} are incoherent.`);
    if (rule.required !== false && (value === '' || (typeof value === 'string' && value.trim() === ''))) { errors.push(Object.freeze({ field: name, code: 'REQUIRED' })); continue; }
    if (rule.type && typeof value !== rule.type) { errors.push(Object.freeze({ field: name, code: 'TYPE' })); continue; }
    if (typeof value === 'string') {
      if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(Object.freeze({ field: name, code: 'MIN_LENGTH' }));
      if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(Object.freeze({ field: name, code: 'MAX_LENGTH' }));
      if (allowPattern && rule.pattern !== undefined) {
        if (typeof rule.pattern !== 'string' || rule.pattern.length > 200) invalid(`pattern for ${name} is invalid.`);
        let pattern; try { pattern = new RegExp(rule.pattern, 'u'); } catch { invalid(`pattern for ${name} is invalid.`); }
        if (!pattern.test(value)) errors.push(Object.freeze({ field: name, code: 'PATTERN' }));
      }
    }
  }
  return Object.freeze(errors);
}

export function requireExactPlain(value, keys) { exactPlain(value, keys); }
