import { validPdfKitOutlineLabel } from '../../src/core/pdfkit-outline-label.js';
import { exactObject, fail, pageNumber } from './pdfkit-mutation-contract-shared.mjs';

export function normalizeOutlineBookmarkMutation(value, sourceInspection) {
  const input = exactObject(value, new Set(['bookmark']), 'mutation');
  const bookmark = exactObject(
    input.bookmark,
    new Set(['page', 'label']),
    'mutation.bookmark',
  );
  if (!validPdfKitOutlineLabel(bookmark.label)) {
    fail(
      'INVALID_PDFKIT_MUTATION',
      'mutation.bookmark.label must be canonical bounded text without control characters.',
    );
  }
  return Object.freeze({
    mutation: Object.freeze({
      bookmark: Object.freeze({
        page: pageNumber(
          bookmark.page,
          sourceInspection.pageCount,
          'mutation.bookmark.page',
        ),
        label: bookmark.label,
      }),
    }),
    editCount: 1,
    targeted: false,
    outlineBookmark: true,
    expectedForm: 'none',
  });
}
