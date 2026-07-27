import { validPdfKitOutlineLabel } from '../../src/core/pdfkit-outline-label.js';
import { exactObject, fail, outlineLocator } from './pdfkit-mutation-contract-shared.mjs';

export function normalizeOutlineBookmarkRenameMutation(value) {
  const input = exactObject(value, new Set(['bookmarkRename']), 'mutation');
  const bookmarkRename = exactObject(
    input.bookmarkRename,
    new Set(['topLevelIndex', 'fingerprint', 'label']),
    'mutation.bookmarkRename',
  );
  if (!validPdfKitOutlineLabel(bookmarkRename.label)) {
    fail(
      'INVALID_PDFKIT_MUTATION',
      'mutation.bookmarkRename.label must be trimmed NFC bounded text without control or format characters.',
    );
  }
  return Object.freeze({
    mutation: Object.freeze({
      bookmarkRename: Object.freeze({
        ...outlineLocator({
          topLevelIndex: bookmarkRename.topLevelIndex,
          fingerprint: bookmarkRename.fingerprint,
        }, 'mutation.bookmarkRename'),
        label: bookmarkRename.label,
      }),
    }),
    editCount: 1,
    targeted: false,
    outlineBookmarkRename: true,
    expectedForm: 'none',
  });
}
