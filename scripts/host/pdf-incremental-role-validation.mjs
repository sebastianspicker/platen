import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { resolvePdfObject } from './pdf-classic-structure.mjs';

function invalid() {
  const error = new Error('The incremental PDF role objects are invalid.');
  error.code = 'INVALID_INCREMENTAL_ROLE_OBJECTS';
  return error;
}

function sameReference(left, right) {
  return left.object === right.object && left.generation === right.generation;
}

function roleObject(structure, records, objects, reference) {
  const index = records.findIndex((record) => sameReference(record.reference, reference));
  if (index >= 0) return objects[index];
  return resolvePdfObject(structure, reference);
}

export function validateIncrementalRoleObjects(structure, records, objects, infoReference) {
  try {
    if (!Array.isArray(records) || !Array.isArray(objects)
      || records.length !== objects.length) throw invalid();
    const root = roleObject(structure, records, objects, structure.root);
    const catalog = pdfDictionary(root.value);
    if (root.stream || catalog.get('Type')?.type !== 'name'
      || catalog.get('Type').value !== 'Catalog' || catalog.has('Perms')) throw invalid();
    if (infoReference) {
      const info = roleObject(structure, records, objects, infoReference);
      if (info.stream) throw invalid();
      pdfDictionary(info.value);
    }
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_ROLE_OBJECTS') throw error;
    throw invalid();
  }
}
