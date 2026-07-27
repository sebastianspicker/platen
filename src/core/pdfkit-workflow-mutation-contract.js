import {
  boundedPdfKitContents,
  boundedPdfKitRectangle,
  PDFKIT_WORKFLOW_SHA256,
  selectedPdfKitInventoryPage,
} from './pdfkit-workflow-contract-shared.js';
import { buildStandardMetadataMutation } from './pdf-incremental-metadata-contract.js';

const PAGE_BOXES = new Set(['media', 'crop', 'bleed', 'trim', 'art']);
const INERT_ANNOTATIONS = new Set(['text', 'freeText', 'square', 'circle', 'highlight']);
const TARGETABLE_ANNOTATIONS = new Set(['freeText', 'square', 'circle', 'highlight']);

function rectangleContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export function isSupportedPdfKitFormWidget(widget) {
  return ['text', 'choice'].includes(widget?.fieldType)
    || (widget?.fieldType === 'button'
      && ['checkbox', 'radio'].includes(widget?.controlKind));
}

export function buildPdfKitMutation(kind, state) {
  const mutation = { metadata: null, pageBox: null, rotation: null, annotations: [] };
  if (kind === 'metadata') {
    mutation.metadata = buildStandardMetadataMutation(state);
    return mutation;
  }
  if (kind === 'page-box') {
    if (!PAGE_BOXES.has(state.pdfkitPageBox)) {
      throw new Error('Choose a supported PDF page box.');
    }
    const rect = boundedPdfKitRectangle(state, state.pdfkitPageBoxRect, 'Page box');
    if (['crop', 'bleed'].includes(state.pdfkitPageBox)) {
      const page = selectedPdfKitInventoryPage(state);
      const current = page?.boxes?.[state.pdfkitPageBox];
      if (current && ['x', 'y', 'width', 'height'].every(
        (key) => Math.abs(rect[key] - current[key]) <= 0.01,
      )) {
        const label = state.pdfkitPageBox === 'crop' ? 'CropBox' : 'BleedBox';
        throw new Error(`Choose a ${label} that differs from the selected page’s current ${label}.`);
      }
      if (state.pdfkitPageBox === 'bleed' && page?.boxes?.trim
        && !rectangleContains(rect, page.boxes.trim)) {
        throw new Error('Choose a BleedBox that fully contains the selected page’s TrimBox.');
      }
    }
    mutation.pageBox = { page: state.selectedPage, box: state.pdfkitPageBox, rect };
    return mutation;
  }
  if (kind === 'rotation') {
    const degrees = Number(state.pdfkitPageRotation);
    if (!Number.isSafeInteger(degrees) || ![0, 90, 180, 270].includes(degrees)) {
      throw new Error('Choose an absolute page rotation of 0°, 90°, 180°, or 270°.');
    }
    mutation.rotation = { page: state.selectedPage, degrees };
    return mutation;
  }
  if (kind === 'annotation') {
    if (!INERT_ANNOTATIONS.has(state.pdfkitAnnotationSubtype)) {
      throw new Error('Choose a supported inert annotation type.');
    }
    mutation.annotations = [{
      page: state.selectedPage,
      subtype: state.pdfkitAnnotationSubtype,
      contents: boundedPdfKitContents(state.pdfkitAnnotationContents, 'Annotation contents'),
      rect: boundedPdfKitRectangle(state, state.pdfkitAnnotationRect, 'Annotation'),
    }];
    return mutation;
  }
  throw new Error('Choose a supported PDFKit derived-copy operation.');
}

export function buildPdfKitTargetedMutation(kind, state) {
  const page = selectedPdfKitInventoryPage(state);
  if (!page) throw new Error('The selected page is not present in the bound PDFKit inventory.');
  const mutation = { formFill: null, annotationUpdate: null, annotationRemove: null };
  if (kind === 'form-fill') {
    if (!/^\d+$/.test(String(state.pdfkitWidgetIndex ?? ''))) {
      throw new Error('Choose a supported source-bound form field.');
    }
    const annotationIndex = Number(state.pdfkitWidgetIndex);
    const widget = page.widgets?.find((entry) => entry.annotationIndex === annotationIndex);
    if (!isSupportedPdfKitFormWidget(widget)
      || !PDFKIT_WORKFLOW_SHA256.test(widget.fingerprint ?? '')) {
      throw new Error('Choose a supported source-bound text, choice, checkbox, or radio field.');
    }
    const value = widget.controlKind === 'radio' ? 'select'
      : widget.fieldType === 'button'
        ? String(state.pdfkitButtonState ?? '') : String(state.pdfkitFormValue ?? '');
    if (widget.controlKind === 'checkbox' && !['on', 'off'].includes(value)) {
      throw new Error('Choose whether the checkbox should be on or off.');
    }
    if (new TextEncoder().encode(value).byteLength > 1_024) {
      throw new Error('Form value exceeds 1,024 UTF-8 bytes.');
    }
    mutation.formFill = {
      page: page.index,
      annotationIndex: widget.annotationIndex,
      fingerprint: widget.fingerprint,
      fieldType: widget.fieldType,
      value,
    };
    return mutation;
  }
  const annotationIndex = Number(state.pdfkitExistingAnnotationIndex);
  const annotation = page.annotations?.find((entry) => entry.annotationIndex === annotationIndex);
  if (!annotation || !TARGETABLE_ANNOTATIONS.has(annotation.subtype)
    || !PDFKIT_WORKFLOW_SHA256.test(annotation.fingerprint ?? '')) {
    throw new Error('Choose a supported source-bound inert annotation.');
  }
  const target = {
    page: page.index,
    annotationIndex: annotation.annotationIndex,
    fingerprint: annotation.fingerprint,
    subtype: annotation.subtype,
  };
  if (kind === 'annotation-remove') {
    mutation.annotationRemove = target;
    return mutation;
  }
  if (kind === 'annotation-update') {
    mutation.annotationUpdate = {
      ...target,
      contents: boundedPdfKitContents(
        state.pdfkitExistingAnnotationContents,
        'Updated annotation contents',
      ),
      rect: boundedPdfKitRectangle(
        state,
        state.pdfkitExistingAnnotationRect,
        'Updated annotation',
      ),
    };
    return mutation;
  }
  throw new Error('Choose a supported source-bound PDFKit operation.');
}
