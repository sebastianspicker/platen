import { createApplicationDocumentActions } from './application-click-document-actions.js';
import { createApplicationPdfKitActions } from './application-click-pdfkit-actions.js';
import { createApplicationReviewActions } from './application-click-review-actions.js';
import { createApplicationViewActions } from './application-click-view-actions.js';

export function createApplicationClickActions(context) {
  return Object.freeze({
    ...createApplicationViewActions(context),
    ...createApplicationDocumentActions(context),
    ...createApplicationReviewActions(context),
    ...createApplicationPdfKitActions(context),
  });
}
