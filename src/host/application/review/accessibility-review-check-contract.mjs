export const ACCESSIBILITY_REVIEW_CHECK_EVIDENCE_REFS = Object.freeze({
  'tagged-indicator': Object.freeze(['poppler.pdfinfo']),
  'tag-structure-listing': Object.freeze(['poppler.pdfinfo-struct']),
  'tag-role-inventory': Object.freeze(['poppler.pdfinfo-struct']),
  'heading-role-sequence': Object.freeze(['poppler.pdfinfo-struct']),
  'list-role-shape': Object.freeze(['poppler.pdfinfo-struct']),
  'table-role-shape': Object.freeze(['poppler.pdfinfo-struct']),
  'document-title': Object.freeze(['poppler.pdfinfo']),
  'document-language': Object.freeze([
    'poppler.pdfinfo-meta',
    'poppler.pdfinfo-custom',
  ]),
  'font-tounicode': Object.freeze(['poppler.pdffonts']),
  'font-embedding': Object.freeze(['poppler.pdffonts']),
  'empty-extracted-text-pages': Object.freeze(['poppler.pdftotext-layout']),
  'image-alt-text': Object.freeze(['poppler.pdfimages-list']),
  'artifact-classification': Object.freeze(['poppler.pdfinfo-struct']),
  'form-semantics': Object.freeze([
    'poppler.pdfinfo',
    'apple-pdfkit.inventory',
  ]),
  'reading-order': Object.freeze(['poppler.pdfinfo-struct']),
  'link-bookmark-semantics': Object.freeze([
    'poppler.pdfinfo-url',
    'apple-pdfkit.outline-inventory',
  ]),
  contrast: Object.freeze(['review-profile.capability-boundary']),
  'screen-reader-permissions': Object.freeze([
    'apple-pdfkit.document-permissions',
  ]),
  'pdf-ua-conformance': Object.freeze(['review-profile.capability-boundary']),
});

export function check(id, status, summary) {
  const bounded = String(summary ?? '').trim().slice(0, 240);
  if (!bounded) {
    throw new TypeError('Accessibility review checks require a bounded summary.');
  }
  const evidenceRefs = ACCESSIBILITY_REVIEW_CHECK_EVIDENCE_REFS[id];
  if (!evidenceRefs) {
    throw new TypeError(`Accessibility review check ${id} has no fixed evidence reference.`);
  }
  return Object.freeze({ id, status, summary: bounded, evidenceRefs });
}
