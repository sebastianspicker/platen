import { snapshotClassicPdfObjectValue } from './pdf-classic-object-value.mjs';

const genericAuthorities = new WeakMap();
const classicAuthorities = new WeakMap();

function copiedStorage(storage) {
  if (!storage) return undefined;
  return Object.freeze({
    ...storage,
    objectStream: Object.freeze({ ...storage.objectStream }),
    ...(storage.predictor ? { predictor: Object.freeze({ ...storage.predictor }) } : {}),
  });
}

export function copyResolvedPdfObject(object) {
  const { buffer: _buffer, storage, ...plain } = object;
  return Object.freeze({
    ...plain,
    reference: Object.freeze({ ...object.reference }),
    value: snapshotClassicPdfObjectValue(object.value).value,
    ...(storage ? { storage: copiedStorage(storage) } : {}),
  });
}

export function exposedPdfObjectMap(objects) {
  return new Map([...objects].map(([key, object]) => [key, copyResolvedPdfObject(object)]));
}

export function brandPdfStructure(structure, authority, kind) {
  const result = Object.freeze(structure);
  (kind === 'generic' ? genericAuthorities : classicAuthorities).set(
    result,
    Object.freeze(authority),
  );
  return result;
}

export function pdfStructureAuthority(structure, kind) {
  return (kind === 'generic' ? genericAuthorities : classicAuthorities).get(structure) ?? null;
}
