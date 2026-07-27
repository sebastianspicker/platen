import {
  exactObject,
  fail,
  locator,
  nullableString,
  rectangle,
} from './pdfkit-mutation-contract-shared.mjs';

const TARGETED_MUTATION_KEYS = new Set(['formFill', 'annotationUpdate', 'annotationRemove']);
const TARGETABLE_ANNOTATIONS = new Set(['freeText', 'square', 'circle', 'highlight']);
const FORM_FIELD_TYPES = new Set(['text', 'choice', 'button']);

export function normalizeTargetedMutation(value, sourceInspection) {
  exactObject(value, TARGETED_MUTATION_KEYS, 'mutation');
  const pageCount = sourceInspection.pageCount;
  const categoryCount = Number(value.formFill !== null)
    + Number(value.annotationUpdate !== null) + Number(value.annotationRemove !== null);
  if (categoryCount !== 1) {
    fail('INVALID_PDFKIT_MUTATION', 'Choose exactly one source-bound PDFKit mutation.');
  }

  let formFill = null;
  if (value.formFill !== null) {
    const target = locator(
      value.formFill,
      new Set(['page', 'annotationIndex', 'fingerprint', 'fieldType', 'value']),
      pageCount,
      'mutation.formFill',
    );
    if (!FORM_FIELD_TYPES.has(value.formFill.fieldType)) {
      fail('INVALID_PDFKIT_MUTATION', 'mutation.formFill.fieldType is unsupported.');
    }
    const fieldValue = nullableString(value.formFill.value, 'mutation.formFill.value');
    if (fieldValue === null) {
      fail('INVALID_PDFKIT_MUTATION', 'mutation.formFill.value must be bounded text.');
    }
    if (value.formFill.fieldType === 'button'
      && !['on', 'off', 'select'].includes(fieldValue)) {
      fail(
        'INVALID_PDFKIT_MUTATION',
        'A button form fill must request exactly on, off, or select.',
      );
    }
    formFill = Object.freeze({
      ...target,
      fieldType: value.formFill.fieldType,
      value: fieldValue,
    });
  }

  let annotationUpdate = null;
  if (value.annotationUpdate !== null) {
    const target = locator(
      value.annotationUpdate,
      new Set(['page', 'annotationIndex', 'fingerprint', 'subtype', 'contents', 'rect']),
      pageCount,
      'mutation.annotationUpdate',
    );
    if (!TARGETABLE_ANNOTATIONS.has(value.annotationUpdate.subtype)) {
      fail('INVALID_PDFKIT_MUTATION', 'mutation.annotationUpdate.subtype is unsupported.');
    }
    const contents = nullableString(
      value.annotationUpdate.contents,
      'mutation.annotationUpdate.contents',
    );
    if (contents === null || Buffer.byteLength(contents, 'utf8') === 0) {
      fail(
        'INVALID_PDFKIT_MUTATION',
        'mutation.annotationUpdate.contents must contain bounded text.',
      );
    }
    annotationUpdate = Object.freeze({
      ...target,
      subtype: value.annotationUpdate.subtype,
      contents,
      rect: rectangle(value.annotationUpdate.rect, 'mutation.annotationUpdate.rect'),
    });
  }

  let annotationRemove = null;
  if (value.annotationRemove !== null) {
    const target = locator(
      value.annotationRemove,
      new Set(['page', 'annotationIndex', 'fingerprint', 'subtype']),
      pageCount,
      'mutation.annotationRemove',
    );
    if (!TARGETABLE_ANNOTATIONS.has(value.annotationRemove.subtype)) {
      fail('INVALID_PDFKIT_MUTATION', 'mutation.annotationRemove.subtype is unsupported.');
    }
    annotationRemove = Object.freeze({
      ...target,
      subtype: value.annotationRemove.subtype,
    });
  }

  return Object.freeze({
    mutation: Object.freeze({ formFill, annotationUpdate, annotationRemove }),
    editCount: 1,
    targeted: true,
    localGoTo: false,
    radioSelection: formFill?.fieldType === 'button' && formFill.value === 'select',
    selectiveSanitization: annotationRemove !== null,
    expectedForm: formFill ? 'acroform' : 'none',
  });
}
