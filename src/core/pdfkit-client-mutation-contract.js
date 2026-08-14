import {
  exactObject,
  validPdfKitLocator,
  validPdfKitRectangle,
} from './pdfkit-client-contract-shared.js';
import { validPdfKitAnnotationProperties } from './pdfkit-targeted-annotation-properties-contract.js';

const PDFKIT_MUTATION_KEYS = new Set(['metadata', 'pageBox', 'rotation', 'annotations']);
const PDFKIT_TARGETED_KEYS = new Set([
  'formFill', 'annotationUpdate', 'annotationProperties', 'annotationRemove',
]);
const PDFKIT_BOXES = new Set(['media', 'crop', 'bleed', 'trim', 'art']);
const PDFKIT_CREATABLE_ANNOTATIONS = new Set([
  'text', 'freeText', 'square', 'circle', 'highlight', 'underline',
]);
const PDFKIT_TARGETABLE_ANNOTATIONS = new Set([
  'freeText', 'square', 'circle', 'highlight',
]);

function validPdfKitText(value) {
  return value === null || (typeof value === 'string'
    && new TextEncoder().encode(value).byteLength <= 1_024);
}

function validPdfKitFormFill(value) {
  if (!validPdfKitLocator(value, ['fieldType', 'value']) || typeof value.value !== 'string') {
    return false;
  }
  if (value.fieldType === 'button') return ['on', 'off', 'select'].includes(value.value);
  return ['text', 'choice'].includes(value.fieldType)
    && new TextEncoder().encode(value.value).byteLength <= 1_024;
}

function validPdfKitAnnotationUpdate(value) {
  const bytes = typeof value.contents === 'string'
    ? new TextEncoder().encode(value.contents).byteLength : 0;
  return validPdfKitLocator(value, ['subtype', 'contents', 'rect'])
    && PDFKIT_TARGETABLE_ANNOTATIONS.has(value.subtype)
    && bytes > 0 && bytes <= 1_024
    && validPdfKitRectangle(value.rect);
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
    + Number(mutation.annotationUpdate !== null) + Number(mutation.annotationProperties !== null)
    + Number(mutation.annotationRemove !== null);
  if (selected !== 1) return false;
  if (mutation.formFill !== null) return validPdfKitFormFill(mutation.formFill);
  if (mutation.annotationUpdate !== null) return validPdfKitAnnotationUpdate(mutation.annotationUpdate);
  if (mutation.annotationProperties !== null) return validPdfKitAnnotationProperties(mutation.annotationProperties);
  return validPdfKitLocator(mutation.annotationRemove, ['subtype'])
    && PDFKIT_TARGETABLE_ANNOTATIONS.has(mutation.annotationRemove.subtype);
}
