import { assert } from '../host-pdfkit-test-core.js';
import { ClassicPdfTestReader } from './classic-pdf-test-reader.js';

function annotationDescriptor(reader, reference) {
  const dictionary = reader.object(reference).text;
  const subtype = /^\/(\S+)$/u.exec(reader.valueForKey(dictionary, 'Subtype'));
  assert.ok(subtype, 'annotation subtype must be a name');
  const rect = reader.valueForKey(dictionary, 'Rect')
    .match(/[+-]?(?:\d+\.?\d*|\.\d+)/gu)?.map(Number);
  assert.equal(rect?.length, 4, 'annotation /Rect must contain four numbers');
  const flags = reader.optionalValueForKey(dictionary, 'F');
  const contents = reader.optionalValueForKey(dictionary, 'Contents');
  const appearance = reader.optionalValueForKey(dictionary, 'AP');
  const numericFlags = flags === null ? 0 : Number(flags);
  assert.ok(Number.isSafeInteger(numericFlags), 'annotation /F must be an integer');
  return {
    subtype: subtype[1],
    rect,
    flags: numericFlags,
    contentsSha256: contents === null ? null : reader.decodedStringDigest(contents),
    appearance: appearance === null ? null : reader.canonicalValue(appearance),
  };
}

function collectPages(reader) {
  const catalog = reader.object(reader.rootReference()).text;
  const pagesRoot = reader.reference(reader.valueForKey(catalog, 'Pages'));
  const pages = [];
  const visited = new Set();
  function visit(reference, depth = 0) {
    assert.ok(
      depth <= 8 && !visited.has(reference.objectNumber),
      'page tree must be bounded and acyclic',
    );
    visited.add(reference.objectNumber);
    const dictionary = reader.object(reference).text;
    const type = reader.valueForKey(dictionary, 'Type');
    if (type === '/Page') {
      pages.push(reference);
      return;
    }
    assert.equal(type, '/Pages', 'page-tree node must be /Page or /Pages');
    for (const child of reader.arrayReferences(reader.valueForKey(dictionary, 'Kids'))) {
      visit(child, depth + 1);
    }
  }
  visit(pagesRoot);
  return pages;
}

export function parseClassicPdfAnnotationPages(data) {
  const reader = new ClassicPdfTestReader(data);
  return collectPages(reader).map((page) => {
    const annots = reader.optionalValueForKey(reader.object(page).text, 'Annots');
    return annots === null
      ? []
      : reader.arrayReferences(annots).map(
        (reference) => annotationDescriptor(reader, reference),
      );
  });
}
