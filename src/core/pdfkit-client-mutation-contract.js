import {
  exactObject,
  validPdfKitLocator,
  validPdfKitRectangle,
} from './pdfkit-client-contract-shared.js';

const PDFKIT_MUTATION_KEYS = new Set(['metadata', 'pageBox', 'rotation', 'annotations']);
const PDFKIT_TARGETED_KEYS = new Set(['formFill', 'annotationUpdate', 'annotationRemove']);
const PDFKIT_BOXES = new Set(['media', 'crop', 'bleed', 'trim', 'art']);
const PDFKIT_CREATABLE_ANNOTATIONS = new Set([
  'text', 'freeText', 'square', 'circle', 'highlight',
]);
const PDFKIT_TARGETABLE_ANNOTATIONS = new Set([
  'freeText', 'square', 'circle', 'highlight',
]);

function validPdfKitText(value) {
  return value === null || (typeof value === 'string'
    && new TextEncoder().encode(value).byteLength <= 1_024);
}

export function validPdfKitMutation(mutation) {
  if (!exactObject(mutation, [...PDFKIT_MUTATION_KEYS])
    || !Array.isArray(mutation.annotations) || mutation.annotations.length > 1) return false;
  const metadata = mutation.metadata === null
    || (exactObject(mutation.metadata, ['title', 'author', 'subject', 'keywords'])
      && Object.values(mutation.metadata).every(validPdfKitText));
  const pageBox = mutation.pageBox === null
    || (exactObject(mutation.pageBox, ['page', 'box', 'rect'])
      && Number.isSafeInteger(mutation.pageBox.page) && mutation.pageBox.page >= 1
      && PDFKIT_BOXES.has(mutation.pageBox.box) && validPdfKitRectangle(mutation.pageBox.rect));
  const rotation = mutation.rotation === null
    || (exactObject(mutation.rotation, ['page', 'degrees'])
      && Number.isSafeInteger(mutation.rotation.page) && mutation.rotation.page >= 1
      && Number.isSafeInteger(mutation.rotation.degrees)
      && [0, 90, 180, 270].includes(mutation.rotation.degrees));
  const annotations = mutation.annotations.every((annotation) => (
    exactObject(annotation, ['page', 'subtype', 'contents', 'rect'])
      && Number.isSafeInteger(annotation.page) && annotation.page >= 1
      && PDFKIT_CREATABLE_ANNOTATIONS.has(annotation.subtype)
      && typeof annotation.contents === 'string'
      && new TextEncoder().encode(annotation.contents).byteLength > 0
      && new TextEncoder().encode(annotation.contents).byteLength <= 1_024
      && validPdfKitRectangle(annotation.rect)
  ));
  return metadata && pageBox && rotation && annotations
    && Number(mutation.metadata !== null) + Number(mutation.pageBox !== null)
      + Number(mutation.rotation !== null) + Number(mutation.annotations.length === 1) === 1;
}

export function validPdfKitTargetedMutation(mutation) {
  if (!exactObject(mutation, [...PDFKIT_TARGETED_KEYS])) return false;
  const selected = Number(mutation.formFill !== null)
    + Number(mutation.annotationUpdate !== null) + Number(mutation.annotationRemove !== null);
  if (selected !== 1) return false;
  if (mutation.formFill !== null) {
    if (!validPdfKitLocator(mutation.formFill, ['fieldType', 'value'])
      || typeof mutation.formFill.value !== 'string') return false;
    if (mutation.formFill.fieldType === 'button') {
      return ['on', 'off', 'select'].includes(mutation.formFill.value);
    }
    return ['text', 'choice'].includes(mutation.formFill.fieldType)
      && new TextEncoder().encode(mutation.formFill.value).byteLength <= 1_024;
  }
  if (mutation.annotationUpdate !== null) {
    const bytes = typeof mutation.annotationUpdate.contents === 'string'
      ? new TextEncoder().encode(mutation.annotationUpdate.contents).byteLength : 0;
    return validPdfKitLocator(mutation.annotationUpdate, ['subtype', 'contents', 'rect'])
      && PDFKIT_TARGETABLE_ANNOTATIONS.has(mutation.annotationUpdate.subtype)
      && bytes > 0 && bytes <= 1_024
      && validPdfKitRectangle(mutation.annotationUpdate.rect);
  }
  return validPdfKitLocator(mutation.annotationRemove, ['subtype'])
    && PDFKIT_TARGETABLE_ANNOTATIONS.has(mutation.annotationRemove.subtype);
}
