import {
  pagesMerge, pagesSplit, pagesExtract, pagesReorder, pagesDelete, pagesInsert,
  pagesReplace, pagesDuplicate, pagesCopyBetweenDocuments, pagesReverseInterleave,
  pagesSplitByRule,
} from './page-organization-composition.mjs';
import {
  pagesCrop, pagesRotate, pagesPageBoxes, pagesLabelsNumbering, pagesTransitions,
  pagesResize, pagesInsertBlank,
} from './page-organization-mutations.mjs';

export {
  pagesMerge, pagesSplit, pagesExtract, pagesReorder, pagesDelete, pagesInsert,
  pagesReplace, pagesDuplicate, pagesCopyBetweenDocuments, pagesReverseInterleave,
  pagesSplitByRule, pagesCrop, pagesRotate, pagesPageBoxes, pagesLabelsNumbering,
  pagesTransitions, pagesResize, pagesInsertBlank,
};

export const handlers = Object.freeze({
  'pages.merge': pagesMerge,
  'pages.split': pagesSplit,
  'pages.extract': pagesExtract,
  'pages.reorder': pagesReorder,
  'pages.delete': pagesDelete,
  'pages.crop': pagesCrop,
  'pages.rotate': pagesRotate,
  'pages.insert': pagesInsert,
  'pages.replace': pagesReplace,
  'pages.duplicate': pagesDuplicate,
  'pages.copy-between-documents': pagesCopyBetweenDocuments,
  'pages.resize': pagesResize,
  'pages.page-boxes': pagesPageBoxes,
  'pages.labels-numbering': pagesLabelsNumbering,
  'pages.reverse-interleave': pagesReverseInterleave,
  'pages.insert-blank': pagesInsertBlank,
  'pages.transitions': pagesTransitions,
  'pages.split-by-rule': pagesSplitByRule,
});
