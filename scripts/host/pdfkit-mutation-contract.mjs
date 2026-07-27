import { PDFKIT_MAX_REQUEST_BYTES } from './adapters/pdfkit.mjs';
import { normalizeGeneralMutation } from './pdfkit-general-mutation-contract.mjs';
import {
  normalizeInkAnnotationMutation,
  normalizeLineAnnotationMutation,
  normalizeLocalGoToMutation,
} from './pdfkit-navigation-annotation-contract.mjs';
import { normalizeOutlineBookmarkMutation } from './pdfkit-outline-mutation-contract.mjs';
import { normalizeOutlineBookmarkRemovalMutation } from './pdfkit-outline-removal-contract.mjs';
import { normalizeOutlineBookmarkRenameMutation } from './pdfkit-outline-rename-contract.mjs';
import { normalizeLocalGoToRemovalMutation } from './pdfkit-local-goto-removal-contract.mjs';
import {
  DEFAULT_PDFKIT_MUTATION_LIMITS,
  fail,
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_TARGETED_PROFILE,
} from './pdfkit-mutation-contract-shared.mjs';
import { normalizeTargetedMutation } from './pdfkit-targeted-mutation-contract.mjs';

export {
  DEFAULT_PDFKIT_MUTATION_LIMITS,
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_TARGETED_PROFILE,
};

const SUPPORTED_PROFILES = new Set([
  PDFKIT_DERIVED_PROFILE,
  PDFKIT_TARGETED_PROFILE,
  PDFKIT_LOCAL_GOTO_PROFILE,
  PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_PROFILE,
  PDFKIT_OUTLINE_REMOVAL_PROFILE,
  PDFKIT_OUTLINE_RENAME_PROFILE,
  PDFKIT_LINE_ANNOTATION_PROFILE,
  PDFKIT_INK_ANNOTATION_PROFILE,
]);

export function normalizePdfKitMutation({ profile, input, sourceInspection }) {
  if (!SUPPORTED_PROFILES.has(profile)) {
    fail('INVALID_PDFKIT_MUTATION', 'The PDFKit mutation profile is unsupported.');
  }
  if (profile === PDFKIT_TARGETED_PROFILE) return normalizeTargetedMutation(input, sourceInspection);
  if (profile === PDFKIT_LOCAL_GOTO_PROFILE) return normalizeLocalGoToMutation(input, sourceInspection);
  if (profile === PDFKIT_LOCAL_GOTO_REMOVAL_PROFILE) return normalizeLocalGoToRemovalMutation(input, sourceInspection);
  if (profile === PDFKIT_OUTLINE_PROFILE) return normalizeOutlineBookmarkMutation(input, sourceInspection);
  if (profile === PDFKIT_OUTLINE_REMOVAL_PROFILE) return normalizeOutlineBookmarkRemovalMutation(input);
  if (profile === PDFKIT_OUTLINE_RENAME_PROFILE) return normalizeOutlineBookmarkRenameMutation(input);
  if (profile === PDFKIT_LINE_ANNOTATION_PROFILE) return normalizeLineAnnotationMutation(input, sourceInspection);
  if (profile === PDFKIT_INK_ANNOTATION_PROFILE) return normalizeInkAnnotationMutation(input, sourceInspection);
  return normalizeGeneralMutation(input, sourceInspection);
}

function helperOperation(normalized) {
  if (normalized.localGoTo) return 'addLocalGoToLink';
  if (normalized.localGoToRemoval) return 'removeLocalGoToLink';
  if (normalized.outlineBookmark) return 'appendOutlineBookmark';
  if (normalized.outlineBookmarkRemoval) return 'removeOutlineBookmark';
  if (normalized.outlineBookmarkRename) return 'renameOutlineBookmark';
  if (normalized.lineAnnotation) return 'addLineAnnotation';
  if (normalized.inkAnnotation) return 'addInkAnnotation';
  if (normalized.targeted) return 'targetedMutate';
  return 'mutate';
}

export function serializePdfKitMutationRequest(normalized, limits, sourceSha256) {
  if ((normalized.outlineBookmark || normalized.outlineBookmarkRemoval || normalized.outlineBookmarkRename)
    && (limits.maxOutlineDepth < 1 || limits.maxOutlineItems < 1)) {
    fail('INVALID_PDFKIT_MUTATION', 'Bookmark mutation requires positive outline limits.');
  }
  const request = {
    version: 1,
    operation: helperOperation(normalized),
    inputFilename: 'input.pdf',
    outputFilename: 'output.pdf',
    sourceSha256,
    limits: {
      maxPages: limits.maxPages,
      maxAnnotationsPerPage: limits.maxAnnotationsPerPage,
      maxWidgetsPerPage: limits.maxWidgetsPerPage,
      maxOutlineDepth: limits.maxOutlineDepth,
      maxOutlineItems: limits.maxOutlineItems,
    },
  };
  if (normalized.localGoTo) request.link = normalized.mutation.link;
  else if (normalized.localGoToRemoval) request.link = normalized.mutation.linkRemoval;
  else if (normalized.outlineBookmark) request.bookmark = normalized.mutation.bookmark;
  else if (normalized.outlineBookmarkRemoval) request.bookmark = normalized.mutation.bookmarkRemoval;
  else if (normalized.outlineBookmarkRename) request.bookmarkRename = normalized.mutation.bookmarkRename;
  else if (normalized.lineAnnotation) request.line = normalized.mutation.line;
  else if (normalized.inkAnnotation) request.ink = normalized.mutation.ink;
  else request.mutation = normalized.mutation;
  const value = JSON.stringify(request);
  if (Buffer.byteLength(value, 'utf8') > PDFKIT_MAX_REQUEST_BYTES) {
    fail('INVALID_PDFKIT_MUTATION', 'The PDFKit mutation request exceeds its byte limit.', 413);
  }
  return value;
}

export function checkPdfKitMutationLimits(configured = {}) {
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)
    || Object.keys(configured).some((key) => !Object.hasOwn(DEFAULT_PDFKIT_MUTATION_LIMITS, key))) {
    throw new TypeError('PDFKit mutation limits are invalid.');
  }
  const limits = { ...DEFAULT_PDFKIT_MUTATION_LIMITS, ...configured };
  for (const [key, maximum] of Object.entries(DEFAULT_PDFKIT_MUTATION_LIMITS)) {
    const minimum = ['maxAnnotationsPerPage', 'maxWidgetsPerPage', 'maxOutlineDepth', 'maxOutlineItems'].includes(key) ? 0 : 1;
    if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > maximum) {
      throw new TypeError('PDFKit mutation limits must not exceed the fixed local bounds.');
    }
  }
  return Object.freeze(limits);
}

export function summarizePdfKitMutation(mutation) {
  if (Object.hasOwn(mutation, 'bookmarkRemoval')) return Object.freeze({
    category: 'outline-bookmark-removal',
    topLevelIndex: mutation.bookmarkRemoval.topLevelIndex,
  });
  if (Object.hasOwn(mutation, 'bookmarkRename')) return Object.freeze({
    category: 'outline-bookmark-rename',
    topLevelIndex: mutation.bookmarkRename.topLevelIndex,
  });
  if (Object.hasOwn(mutation, 'linkRemoval')) return Object.freeze({
    category: 'local-goto-link-removal',
    page: mutation.linkRemoval.page,
    annotationIndex: mutation.linkRemoval.annotationIndex,
  });
  if (Object.hasOwn(mutation, 'bookmark')) return Object.freeze({
    category: 'outline-bookmark', targetPage: mutation.bookmark.page,
  });
  if (Object.hasOwn(mutation, 'link')) return Object.freeze({
    category: 'local-goto-link',
    sourcePage: mutation.link.sourcePage,
    targetPage: mutation.link.targetPage,
  });
  if (Object.hasOwn(mutation, 'line')) return Object.freeze({
    category: 'line-annotation', page: mutation.line.page,
  });
  if (Object.hasOwn(mutation, 'ink')) return Object.freeze({
    category: 'ink-annotation', page: mutation.ink.page,
  });
  if (Object.hasOwn(mutation, 'formFill')) {
    if (mutation.formFill) return Object.freeze({
      category: mutation.formFill.fieldType === 'choice' && mutation.formFill.value === ''
        ? 'form-choice-clear'
        : mutation.formFill.fieldType === 'button' && mutation.formFill.value === 'select'
          ? 'form-radio-select' : 'form-fill', page: mutation.formFill.page,
      annotationIndex: mutation.formFill.annotationIndex, fieldType: mutation.formFill.fieldType,
    });
    const targeted = mutation.annotationUpdate ?? mutation.annotationRemove;
    return Object.freeze({
      category: mutation.annotationUpdate ? 'annotation-update' : 'annotation-remove',
      page: targeted.page, annotationIndex: targeted.annotationIndex, subtype: targeted.subtype,
    });
  }
  return Object.freeze({
    metadataFields: mutation.metadata ? ['title', 'author', 'subject', 'keywords'] : [],
    pageBox: mutation.pageBox ? { page: mutation.pageBox.page, box: mutation.pageBox.box } : null,
    rotation: mutation.rotation ? { page: mutation.rotation.page, degrees: mutation.rotation.degrees } : null,
    annotations: mutation.annotations.map(({ page, subtype }) => ({ page, subtype })),
  });
}
