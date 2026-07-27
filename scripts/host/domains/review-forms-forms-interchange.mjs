import { MAX_RECORDS, csv, fail, json } from './review-forms-validation.mjs';

export function exportForms(snapshot) {
  const rows = [
    ['fieldId', 'name', 'value'],
    ...snapshot.namespaces.formFields.map((field) => [
      field.id,
      field.name,
      snapshot.namespaces.formValues.find((value) => value.id === field.id)?.value ?? '',
    ]),
  ];
  return {
    format: 'platen-forms-v1',
    fields: snapshot.namespaces.formFields.map(json),
    values: snapshot.namespaces.formValues.map(json),
    csv: rows.map((row) => row.map(csv).join(',')).join('\r\n'),
  };
}

export function importForms(workspace, documentId, input, expectedRevision, engine) {
  const valid = input && input.format === 'platen-forms-v1'
    && Array.isArray(input.fields) && Array.isArray(input.values)
    && input.fields.length <= MAX_RECORDS && input.values.length <= MAX_RECORDS;
  if (!valid) fail('INVALID_INTERCHANGE', 'Invalid bounded forms interchange.');
  return workspace.mutate(documentId, expectedRevision, (snapshot) => {
    snapshot.namespaces.formFields = input.fields.map((field) => engine.field(field));
    const ids = new Set(snapshot.namespaces.formFields.map((field) => field.id));
    const names = new Set(snapshot.namespaces.formFields.map((field) => field.name));
    if (ids.size !== snapshot.namespaces.formFields.length
      || names.size !== snapshot.namespaces.formFields.length) {
      fail('INVALID_INTERCHANGE', 'Imported fields must have unique ids and names.');
    }
    snapshot.namespaces.formValues = input.values.map((value) => {
      const field = snapshot.namespaces.formFields.find(
        (candidate) => candidate.id === value.id,
      );
      if (!field) fail('INVALID_INTERCHANGE', 'Imported value references unknown field.');
      return { id: field.id, value: engine.normalizeValue(field, value.value), updatedAt: workspace.now() };
    });
    engine.calculate(snapshot);
  });
}
