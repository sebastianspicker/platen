import {
  validPdfKitLocator,
  validPdfKitRectangle,
} from './pdfkit-client-contract-shared.js';

const CANONICAL_STROKE_COLOR = /^#[0-9a-f]{6}$/;

export function validPdfKitAnnotationProperties(value) {
  return validPdfKitLocator(value, ['subtype', 'rect', 'strokeColor'])
    && value.subtype === 'square'
    && validPdfKitRectangle(value.rect)
    && typeof value.strokeColor === 'string'
    && CANONICAL_STROKE_COLOR.test(value.strokeColor);
}

export function canonicalPdfKitStrokeColor(value) {
  if (typeof value !== 'string' || !CANONICAL_STROKE_COLOR.test(value)) {
    throw new Error('Choose a lowercase #rrggbb stroke color.');
  }
  return value;
}
