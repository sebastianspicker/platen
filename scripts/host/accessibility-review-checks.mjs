import { check } from './accessibility-review-check-contract.mjs';
import { contentChecks } from './accessibility-review-check-content.mjs';
import { summarizePdfKit } from './accessibility-review-check-pdfkit.mjs';
import {
  languageFromStructure,
  tagSemanticChecks,
} from './accessibility-review-check-tag-structure.mjs';

export { check, languageFromStructure, summarizePdfKit, tagSemanticChecks };

export function buildChecks({
  inspection,
  structure,
  fonts,
  images,
  pages,
  taggedIndicator,
  tagStructure,
  roles,
  pdfkit,
}) {
  const { checks: content, evidence } = contentChecks({
    inspection,
    structure,
    fonts,
    images,
    pages,
    roles,
    pdfkit,
  });
  const checks = [
    check(
      'tagged-indicator',
      taggedIndicator ? 'pass' : 'fail',
      taggedIndicator
        ? 'Poppler reported the document as tagged.'
        : 'Poppler did not report the document as tagged.',
    ),
    check(
      'tag-structure-listing',
      tagStructure ? 'pass' : 'fail',
      tagStructure
        ? 'Poppler returned a tag-structure listing.'
        : 'Poppler did not return a tag-structure listing.',
    ),
    ...tagSemanticChecks({ taggedIndicator, tagStructure, roles }),
    ...content,
  ];
  return { checks: Object.freeze(checks), evidence };
}
