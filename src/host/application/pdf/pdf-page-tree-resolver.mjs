import {
  pdfDictionary,
  pdfReference,
} from './pdf-classic-syntax.mjs';
import {
  resolveClassicPdfObject,
  resolvePdfObject,
} from './pdf-classic-structure.mjs';

export const PDF_PAGE_TREE_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 10_000,
  maxPages: 10_000,
});

function invalid() {
  const error = new Error('PDF page tree is malformed or unsupported.');
  error.code = 'INVALID_PDF_PAGE_TREE';
  return error;
}

function plainRequest(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) throw invalid();
  return value;
}

function ref(value) {
  try { return Object.freeze({ ...pdfReference(value) }); } catch { throw invalid(); }
}

function resolver(structure) {
  if (!structure || typeof structure !== 'object') throw invalid();
  // Classic structures predate the generic parser and intentionally do not
  // expose an xrefFlavor marker. Their authority is still selected by the
  // classic resolver; generic xref/object-stream structures are marked stream.
  if (structure.xrefFlavor === 'classic' || structure.xrefFlavor === undefined) return resolveClassicPdfObject;
  if (structure.xrefFlavor === 'stream') return resolvePdfObject;
  throw invalid();
}

function valueFor(resolve, structure, value) {
  if (value?.type !== 'ref') return value;
  return resolve(structure, value).value;
}

function number(value, key) {
  if (value?.type !== 'number' || !Number.isFinite(value.value)) throw invalid();
  if (key === 'Rotate' && (!value.integer || Math.abs(value.value) > 36000)) throw invalid();
  return value.value;
}

function count(value, maximum) {
  if (value?.type !== 'number' || !value.integer || value.value < 1 || value.value > maximum) throw invalid();
  return value.value;
}

function box(resolve, structure, value, key) {
  const candidate = valueFor(resolve, structure, value);
  if (candidate?.type !== 'array' || candidate.values.length !== 4) throw invalid();
  const result = candidate.values.map((entry) => number(entry, key));
  if (result.some((entry) => !Number.isFinite(entry))) throw invalid();
  return Object.freeze(result);
}

function copyResourceValue(value) {
  if (value?.type === 'dict') {
    return Object.freeze({ type: 'dict', entries: new Map([...value.entries].map(([key, entry]) => [key, copyResourceValue(entry)])) });
  }
  if (value?.type === 'array') return Object.freeze({ type: 'array', values: Object.freeze(value.values.map(copyResourceValue)) });
  if (value?.type === 'string') return Object.freeze({ ...value, bytes: Buffer.from(value.bytes) });
  if (value?.type === 'ref') return Object.freeze({ ...value });
  if (value?.type === 'name' || value?.type === 'number' || value?.type === 'boolean' || value?.type === 'null') return Object.freeze({ ...value });
  throw invalid();
}

function resources(resolve, structure, value) {
  if (value === undefined || value === null) return null;
  const candidate = valueFor(resolve, structure, value);
  if (candidate?.type !== 'dict') throw invalid();
  return copyResourceValue(candidate);
}

function streamContents(resolve, structure, value) {
  if (value === undefined) return Object.freeze([]);
  const values = value?.type === 'array' ? value.values : [value];
  if (value?.type !== 'array' && value?.type !== 'ref') throw invalid();
  const result = values.map((entry) => {
    const reference = ref(entry);
    const object = resolve(structure, reference);
    if (!object.stream || object.value?.type !== 'dict') throw invalid();
    const length = valueFor(resolve, structure, object.value.entries.get('Length'));
    if (length?.type !== 'number' || !length.integer || length.value !== object.streamLength) throw invalid();
    return Object.freeze({
      reference,
      streamLength: object.streamLength,
      streamStart: object.streamStart,
      stream: object,
    });
  });
  return Object.freeze(result);
}

function pageReference(request, structure, resolve) {
  if (request.pagesReference !== undefined) return ref(request.pagesReference);
  const root = ref(structure.root);
  const catalog = resolve(structure, root);
  const entries = pdfDictionary(catalog.value);
  return ref(entries.get('Pages'));
}

export function resolvePdfPageTree(request = {}) {
  try {
    const input = plainRequest(request);
    const structure = input.structure;
    const resolve = resolver(structure);
    const limits = { ...PDF_PAGE_TREE_LIMITS, ...(input.limits ?? {}) };
    for (const key of ['maxDepth', 'maxNodes', 'maxPages']) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > PDF_PAGE_TREE_LIMITS[key]) throw invalid();
    }
    const rootPages = pageReference(input, structure, resolve);
    const active = new Set(); const seen = new Set(); const pages = [];
    let nodes = 0;
    function walk(reference, inherited, depth) {
      if (depth > limits.maxDepth || ++nodes > limits.maxNodes) throw invalid();
      const key = `${reference.object}:${reference.generation}`;
      if (active.has(key) || seen.has(key)) throw invalid();
      active.add(key); seen.add(key);
      try {
        const object = resolve(structure, reference);
        if (object.stream || object.value?.type !== 'dict') throw invalid();
        const entries = pdfDictionary(object.value);
        const type = entries.get('Type');
        if (type?.type !== 'name' || !['Pages', 'Page'].includes(type.value)) throw invalid();
        const next = {
          ...inherited,
          resources: inherited.resources ? copyResourceValue(inherited.resources) : null,
        };
        if (entries.has('MediaBox')) next.mediaBox = box(resolve, structure, entries.get('MediaBox'), 'MediaBox');
        if (entries.has('CropBox')) next.cropBox = box(resolve, structure, entries.get('CropBox'), 'CropBox');
        if (entries.has('Rotate')) next.rotate = number(valueFor(resolve, structure, entries.get('Rotate')), 'Rotate');
        if (entries.has('Resources')) next.resources = resources(resolve, structure, entries.get('Resources'));
        if (type.value === 'Pages') {
          const kids = valueFor(resolve, structure, entries.get('Kids'));
          if (kids?.type !== 'array' || kids.values.length < 1) throw invalid();
          const declaredCount = count(valueFor(resolve, structure, entries.get('Count')), limits.maxPages);
          let descendantCount = 0;
          for (const child of kids.values) descendantCount += walk(ref(child), next, depth + 1);
          if (descendantCount !== declaredCount) throw invalid();
          return descendantCount;
        }
        if (pages.length >= limits.maxPages || !next.mediaBox) throw invalid();
        const effectiveCrop = next.cropBox ?? next.mediaBox;
        const contents = streamContents(resolve, structure, entries.get('Contents'));
        pages.push(Object.freeze({
          index: pages.length,
          reference,
          page: object,
          mediaBox: next.mediaBox,
          cropBox: effectiveCrop,
          rotate: next.rotate ?? 0,
          resources: next.resources,
          contents,
        }));
        return 1;
      } finally { active.delete(key); }
    }
    walk(rootPages, { mediaBox: null, cropBox: null, rotate: null, resources: null }, 0);
    return Object.freeze({ pages: Object.freeze(pages), pageCount: pages.length, pagesReference: rootPages });
  } catch (error) {
    if (error?.code === 'INVALID_PDF_PAGE_TREE') throw error;
    throw invalid();
  }
}

export const resolvePdfPages = resolvePdfPageTree;
export const collectPdfPages = resolvePdfPageTree;
