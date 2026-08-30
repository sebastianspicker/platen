import { pdfReference } from './pdf-classic-syntax.mjs';

export function samePdfReference(left, right) {
  return left?.object === right?.object && left?.generation === right?.generation;
}

export function pdfReferenceText(reference) {
  return `${reference.object} ${reference.generation} R`;
}

export function copyPdfReference(value) {
  const reference = pdfReference(value);
  return Object.freeze({
    type: 'ref',
    object: reference.object,
    generation: reference.generation,
  });
}
