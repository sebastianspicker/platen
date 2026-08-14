export const PDF_JAVASCRIPT_REMOVAL_PROFILE = 'local-document-javascript-removal-v1';

const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_NAME_BYTES = 1_024;
const UNSUPPORTED_KEYS = new Set([
  'A', 'AcroForm', 'AF', 'ByteRange', 'Collection', 'EmbeddedFiles', 'EF', 'FS',
  'Filespec', 'Launch', 'Metadata', 'Movie', 'Perms', 'RichMediaContent', 'Sound',
  'SubmitForm', 'URI', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'PieceInfo',
  'XFA', 'Next', '3DD',
]);

function invalid() { const error = new Error('The PDF JavaScript removal request is outside the supported bounded profile.'); error.code = 'INVALID_PDF_JAVASCRIPT_REMOVAL'; return error; }
function same(left, right) { return left?.type === 'ref' && right?.type === 'ref' && left.object === right.object && left.generation === right.generation; }
function reference(value) { if (value?.type !== 'ref') throw invalid(); return Object.freeze({ type: 'ref', object: value.object, generation: value.generation }); }

export function pdfJavaScriptRemovalFailure() { return invalid(); }

export function normalizePdfJavaScriptRemoval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 1 || Reflect.ownKeys(value)[0] !== 'profile'
    || !Object.hasOwn(descriptors.profile, 'value') || !descriptors.profile.enumerable
    || descriptors.profile.value !== PDF_JAVASCRIPT_REMOVAL_PROFILE) throw invalid();
  return Object.freeze({ profile: PDF_JAVASCRIPT_REMOVAL_PROFILE });
}

export function scanPdfJavaScriptRemovalValue(value, { allowLocus = false } = {}) {
  if (value?.type === 'array') { for (const entry of value.values) scanPdfJavaScriptRemovalValue(entry, { allowLocus }); return; }
  if (value?.type !== 'dict') return;
  const subtype = value.entries.get('Subtype');
  const type = value.entries.get('Type');
  if (value.entries.has('S') || (type?.type === 'name' && type.value === 'Action')) throw invalid();
  if (type?.type === 'name' && ['EmbeddedFile', 'Filespec', 'Metadata', 'Sig', 'XRef', 'ObjStm'].includes(type.value)) throw invalid();
  if (subtype?.type === 'name' && subtype.value === 'Widget') throw invalid();
  if (value.entries.has('FT')) throw invalid();
  for (const [key, entry] of value.entries) {
    if (UNSUPPORTED_KEYS.has(key) || key === 'AA' || key === 'JS' || (!allowLocus && key === 'OpenAction')) throw invalid();
    scanPdfJavaScriptRemovalValue(entry, { allowLocus });
  }
}

function namedValue(value, expected) {
  return value?.type === 'name' && value.value === expected;
}

function boundedBytes(bytes, maximum) {
  return bytes.length >= 1 && bytes.length <= maximum;
}

function supportedCatalog(catalog) {
  return catalog?.type === 'dict'
    && namedValue(catalog.entries.get('Type'), 'Catalog')
    && catalog.entries.get('Pages')?.type === 'ref';
}

function hasOnlyLocusCatalogKeys(catalog) {
  for (const key of catalog.entries.keys()) {
    if (!['Type', 'Pages', 'OpenAction', 'Names'].includes(key)) return false;
  }
  return true;
}

function javascriptAction(action) {
  return !action.stream
    && !action.compressed
    && action.value?.type === 'dict'
    && action.value.entries.size === 2
    && namedValue(action.value.entries.get('S'), 'JavaScript')
    && action.value.entries.get('JS')?.type === 'string'
    && boundedBytes(action.value.entries.get('JS').bytes, MAX_SCRIPT_BYTES);
}

function flatJavaScriptNameTree(nameTree) {
  return !nameTree.stream
    && !nameTree.compressed
    && nameTree.value?.type === 'dict'
    && nameTree.value.entries.size === 1;
}

function javascriptNamePair(nameTree) {
  const pair = nameTree.value.entries.get('Names');
  if (pair?.type !== 'array' || pair.values.length !== 2 || pair.values[0]?.type !== 'string'
    || !boundedBytes(pair.values[0].bytes, MAX_NAME_BYTES)) throw invalid();
  return pair;
}

function openActionLocus(catalog, resolve) {
  const actionReference = reference(catalog.entries.get('OpenAction'));
  const action = resolve(actionReference);
  if (!javascriptAction(action)) throw invalid();
  return Object.freeze({
    kind: 'open-action', actionReference, deletionReferences: Object.freeze([actionReference]),
  });
}

function namesLocus(catalog, resolve) {
  const names = catalog.entries.get('Names');
  if (names?.type !== 'dict' || names.entries.size !== 1 || names.entries.get('JavaScript')?.type !== 'ref') {
    throw invalid();
  }
  const namesReference = reference(names.entries.get('JavaScript'));
  const nameTree = resolve(namesReference);
  if (!flatJavaScriptNameTree(nameTree)) throw invalid();
  const pair = javascriptNamePair(nameTree);
  const actionReference = reference(pair.values[1]);
  const action = resolve(actionReference);
  if (!javascriptAction(action) || same(namesReference, actionReference)) throw invalid();
  return Object.freeze({
    kind: 'names', namesReference, actionReference,
    deletionReferences: Object.freeze([namesReference, actionReference]),
  });
}

export function classifyPdfJavaScriptRemovalLocus(catalog, resolve) {
  if (!supportedCatalog(catalog)) throw invalid();
  const hasOpenAction = catalog.entries.has('OpenAction');
  const hasNames = catalog.entries.has('Names');
  if (hasOpenAction === hasNames) throw invalid();
  if (!hasOnlyLocusCatalogKeys(catalog)) throw invalid();
  return hasOpenAction ? openActionLocus(catalog, resolve) : namesLocus(catalog, resolve);
}
