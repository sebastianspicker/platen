import { ReviewFormsFormsDomain } from './review-forms-forms.mjs';
import { ReviewFormsReviewDomain } from './review-forms-review.mjs';
import { ReviewFormsWorkspace } from './review-forms-workspace.mjs';

/** Session-only prototype records; annotations are never written into PDF bytes. */
export class ReviewFormsDomain {
  #review;
  #forms;

  constructor(workspaceStateStore, options = {}) {
    const workspace = new ReviewFormsWorkspace(workspaceStateStore, options);
    this.#review = new ReviewFormsReviewDomain(workspace);
    this.#forms = new ReviewFormsFormsDomain(workspace);
  }

  createAnnotation(documentId, input, options = {}) {
    return this.#review.createAnnotation(documentId, input, options);
  }

  reply(documentId, annotationId, input, options = {}) {
    return this.#review.reply(documentId, annotationId, input, options);
  }

  updateAnnotation(documentId, annotationId, patch, options = {}) {
    return this.#review.updateAnnotation(documentId, annotationId, patch, options);
  }

  setReviewState(documentId, input, options = {}) {
    return this.#review.setReviewState(documentId, input, options);
  }

  queryAnnotations(documentId, query = {}) {
    return this.#review.queryAnnotations(documentId, query);
  }

  exportReviewJson(documentId) { return this.#review.exportReviewJson(documentId); }

  importReviewJson(documentId, interchange, options = {}) {
    return this.#review.importReviewJson(documentId, interchange, options);
  }

  reviewSummary(documentId) { return this.#review.reviewSummary(documentId); }

  createField(documentId, input, options = {}) {
    return this.#forms.createField(documentId, input, options);
  }

  setValue(documentId, fieldId, value, options = {}) {
    return this.#forms.setValue(documentId, fieldId, value, options);
  }

  resetValues(documentId, options = {}) { return this.#forms.resetValues(documentId, options); }

  validate(documentId) { return this.#forms.validate(documentId); }

  submitResponse(documentId, options = {}) {
    return this.#forms.submitResponse(documentId, options);
  }

  exportForms(documentId) { return this.#forms.exportForms(documentId); }

  importForms(documentId, input, options = {}) {
    return this.#forms.importForms(documentId, input, options);
  }

  detectFields(text, options = {}) { return this.#forms.detectFields(text, options); }

  staticToFillable(documentId, definitions, options = {}) {
    return this.#forms.staticToFillable(documentId, definitions, options);
  }

  unsupportedXfa() { return this.#forms.unsupportedXfa(); }

  unsupportedFlattening() { return this.#forms.unsupportedFlattening(); }
}
