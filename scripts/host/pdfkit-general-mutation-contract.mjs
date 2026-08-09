import {
  exactObject,
  fail,
  nullableString,
  pageNumber,
  rectangle,
} from './pdfkit-mutation-contract-shared.mjs';

const BOXES = new Set(['media', 'crop', 'bleed', 'trim', 'art']);
const CREATABLE_ANNOTATIONS = new Set(['text', 'freeText', 'square', 'circle', 'highlight', 'underline']);
const MUTATION_KEYS = new Set(['metadata', 'pageBox', 'rotation', 'annotations']);

export function normalizeGeneralMutation(value, sourceInspection) {
  exactObject(value, MUTATION_KEYS, 'mutation');
  const pageCount = sourceInspection.pageCount;
  let metadata = null;
  if (value.metadata !== null) {
    const input = exactObject(
      value.metadata,
      new Set(['title', 'author', 'subject', 'keywords']),
      'mutation.metadata',
    );
    metadata = Object.freeze({
      title: nullableString(input.title, 'metadata.title'),
      author: nullableString(input.author, 'metadata.author'),
      subject: nullableString(input.subject, 'metadata.subject'),
      keywords: nullableString(input.keywords, 'metadata.keywords'),
    });
    if (['title', 'author', 'subject', 'keywords'].every(
      (key) => metadata[key] === sourceInspection[key],
    )) {
      fail('INVALID_PDFKIT_MUTATION', 'The metadata mutation would not change the source document.');
    }
  }
  let pageBox = null;
  if (value.pageBox !== null) {
    const input = exactObject(
      value.pageBox,
      new Set(['page', 'box', 'rect']),
      'mutation.pageBox',
    );
    if (!BOXES.has(input.box)) {
      fail('INVALID_PDFKIT_MUTATION', 'mutation.pageBox.box is unsupported.');
    }
    pageBox = Object.freeze({
      page: pageNumber(input.page, pageCount, 'mutation.pageBox.page'),
      box: input.box,
      rect: rectangle(input.rect, 'mutation.pageBox.rect'),
    });
  }
  let rotation = null;
  if (value.rotation !== null) {
    const input = exactObject(
      value.rotation,
      new Set(['page', 'degrees']),
      'mutation.rotation',
    );
    if (!Number.isSafeInteger(input.degrees) || ![0, 90, 180, 270].includes(input.degrees)) {
      fail(
        'INVALID_PDFKIT_MUTATION',
        'mutation.rotation.degrees must be exactly 0, 90, 180, or 270.',
      );
    }
    rotation = Object.freeze({
      page: pageNumber(input.page, pageCount, 'mutation.rotation.page'),
      degrees: input.degrees,
    });
  }
  if (!Array.isArray(value.annotations) || value.annotations.length > 1) {
    fail('INVALID_PDFKIT_MUTATION', 'mutation.annotations must contain no more than one annotation.');
  }
  const annotations = Object.freeze(value.annotations.map((entry, index) => {
    const input = exactObject(
      entry,
      new Set(['page', 'subtype', 'contents', 'rect']),
      `mutation.annotations[${index}]`,
    );
    if (!CREATABLE_ANNOTATIONS.has(input.subtype)) {
      fail('INVALID_PDFKIT_MUTATION', 'Annotation subtype is unsupported.');
    }
    const contents = nullableString(input.contents, `mutation.annotations[${index}].contents`);
    if (contents === null || Buffer.byteLength(contents, 'utf8') === 0) {
      fail('INVALID_PDFKIT_MUTATION', 'Every annotation requires bounded contents.');
    }
    return Object.freeze({
      page: pageNumber(input.page, pageCount, `mutation.annotations[${index}].page`),
      subtype: input.subtype,
      contents,
      rect: rectangle(input.rect, `mutation.annotations[${index}].rect`),
    });
  }));
  const categoryCount = Number(metadata !== null) + Number(pageBox !== null)
    + Number(rotation !== null) + Number(annotations.length === 1);
  if (categoryCount !== 1) {
    fail('INVALID_PDFKIT_MUTATION', 'Choose exactly one bounded PDFKit mutation.');
  }
  return Object.freeze({
    mutation: Object.freeze({ metadata, pageBox, rotation, annotations }),
    editCount: metadata ? 4 : 1,
    targeted: false,
    localGoTo: false,
    requiresUnsigned: annotations.length === 1 || rotation !== null || ['crop', 'bleed'].includes(pageBox?.box),
    expectedForm: 'none',
  });
}
