import {
  copyResolvedPdfObject,
  pdfStructureAuthority,
} from './pdf-structure-authority.mjs';

function invalid() {
  const error = new Error('PDF structure inspection authority is invalid.');
  error.code = 'INVALID_PDF_STRUCTURE_INSPECTION';
  return error;
}

export function visitPdfObjects(structure, visitor) {
  const authority = pdfStructureAuthority(structure, 'generic')
    ?? pdfStructureAuthority(structure, 'classic');
  if (!authority || !(authority.objects instanceof Map)
    || (authority.compressedObjects !== undefined
      && !(authority.compressedObjects instanceof Map))
    || typeof visitor !== 'function') throw invalid();
  let count = 0;
  for (const object of authority.objects.values()) {
    visitor(copyResolvedPdfObject(object));
    count += 1;
  }
  for (const object of authority.compressedObjects?.values() ?? []) {
    visitor(copyResolvedPdfObject(object));
    count += 1;
  }
  return count;
}
