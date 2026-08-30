import { MAX_RECORDS, fail, find, id, json } from './review-forms-validation.mjs';
import { createFormEngine } from './review-forms-form-engine.mjs';
import { detectFields, staticToFillable } from './review-forms-forms-detection.mjs';
import { exportForms, importForms } from './review-forms-forms-interchange.mjs';

export class ReviewFormsFormsDomain {
  #workspace;
  #engine;

  constructor(workspace) {
    this.#workspace = workspace;
    this.#engine = createFormEngine(workspace);
  }

  createField(documentId, input, { expectedRevision } = {}) {
    const field = this.#engine.field(input);
    return this.#workspace.mutate(documentId, expectedRevision, (snapshot) => {
      if (snapshot.namespaces.formFields.length >= MAX_RECORDS) {
        fail('FIELD_LIMIT_EXCEEDED', 'The form field limit has been reached.', 413);
      }
      const duplicate = snapshot.namespaces.formFields.some(
        (candidate) => candidate.id === field.id || candidate.name === field.name,
      );
      if (duplicate) fail('ENTITY_EXISTS', 'A field id or name already exists.', 409);
      snapshot.namespaces.formFields.push(field);
    });
  }

  setValue(documentId, fieldId, value, { expectedRevision } = {}) {
    return this.#workspace.mutate(documentId, expectedRevision, (snapshot) => {
      const field = find(snapshot, 'formFields', id(fieldId, 'field id'), 'field');
      const normalized = this.#engine.normalizeValue(field, value);
      const values = snapshot.namespaces.formValues;
      const index = values.findIndex((item) => item.id === field.id);
      const record = { id: field.id, value: normalized, updatedAt: this.#workspace.now() };
      if (index < 0) values.push(record);
      else values[index] = record;
      this.#engine.calculate(snapshot);
    });
  }

  resetValues(documentId, { expectedRevision } = {}) {
    return this.#workspace.mutate(documentId, expectedRevision, (snapshot) => {
      snapshot.namespaces.formValues = snapshot.namespaces.formFields.map((field) => ({
        id: field.id,
        value: this.#engine.normalizeValue(field, field.defaultValue),
        updatedAt: this.#workspace.now(),
      }));
      this.#engine.calculate(snapshot);
    });
  }

  validate(documentId) { return this.#engine.validate(this.#workspace.snapshot(documentId)); }

  submitResponse(documentId, { expectedRevision } = {}) {
    const errors = this.validate(documentId);
    if (errors.length) fail('FORM_INVALID', 'The form has validation errors.', 422);
    return this.#workspace.mutate(documentId, expectedRevision, (snapshot) => {
      if (snapshot.namespaces.workflowRecords.length >= MAX_RECORDS) {
        fail('RESPONSE_LIMIT_EXCEEDED', 'The response limit has been reached.', 413);
      }
      snapshot.namespaces.workflowRecords.push({
        id: this.#workspace.newId('response'),
        kind: 'formResponse',
        values: json(snapshot.namespaces.formValues),
        submittedAt: this.#workspace.now(),
      });
    });
  }

  exportForms(documentId) { return exportForms(this.#workspace.snapshot(documentId)); }

  importForms(documentId, input, { expectedRevision } = {}) {
    return importForms(this.#workspace, documentId, input, expectedRevision, this.#engine);
  }

  detectFields(text, options = {}) { return detectFields(text, options); }

  staticToFillable(documentId, definitions, options = {}) {
    return staticToFillable(
      this.#workspace,
      this.createField.bind(this),
      documentId,
      definitions,
      options,
    );
  }

  unsupportedXfa() {
    return { supported: false, code: 'XFA_UNSUPPORTED', message: 'XFA workflows are not supported by this local prototype.' };
  }

  unsupportedFlattening() {
    return { supported: false, code: 'PDF_FLATTENING_UNSUPPORTED', message: 'PDF flattening is not supported by this local prototype.' };
  }
}
