import {
  exactObject,
  outlineLocator,
} from './pdfkit-mutation-contract-shared.mjs';

export function normalizeOutlineBookmarkRemovalMutation(value) {
  const input = exactObject(value, new Set(['bookmarkRemoval']), 'mutation');
  return Object.freeze({
    mutation: Object.freeze({
      bookmarkRemoval: outlineLocator(
        input.bookmarkRemoval,
        'mutation.bookmarkRemoval',
      ),
    }),
    editCount: 1,
    targeted: false,
    outlineBookmarkRemoval: true,
    expectedForm: 'none',
  });
}
