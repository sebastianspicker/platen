import { handleDocumentReadRoute } from './document-service-route-read.mjs';
import { handleDocumentMutationRoute } from './document-service-route-mutations.mjs';
import { handleDocumentOcrRoute } from './document-service-route-ocr.mjs';

const DOCUMENT_SERVICE_HANDLERS = new Map([
  ['source', handleDocumentReadRoute], ['inspection', handleDocumentReadRoute], ['structure', handleDocumentReadRoute],
  ['text', handleDocumentReadRoute], ['thumbnail', handleDocumentReadRoute], ['cropbox-raster', handleDocumentReadRoute],
  ['cropbox-snapshot', handleDocumentReadRoute], ['fonts', handleDocumentReadRoute], ['images', handleDocumentReadRoute],
  ['attachments', handleDocumentReadRoute], ['signatures', handleDocumentReadRoute],
  ['extract', handleDocumentMutationRoute], ['arrange', handleDocumentMutationRoute], ['delete', handleDocumentMutationRoute], ['merge', handleDocumentMutationRoute],
  ['split', handleDocumentMutationRoute], ['split-rule', handleDocumentMutationRoute], ['duplicate', handleDocumentMutationRoute],
  ['reverse', handleDocumentMutationRoute], ['interleave', handleDocumentMutationRoute], ['insert', handleDocumentMutationRoute],
  ['replace', handleDocumentMutationRoute], ['ocr', handleDocumentOcrRoute], ['ocr-analysis', handleDocumentOcrRoute],
  ['rewrite', handleDocumentOcrRoute],
]);

// Handles the document-service family after the router has applied host, auth,
// origin, cancellation, and error policies. Returns false for other families.
export async function handleDocumentServiceRoute(context) {
  const handler = DOCUMENT_SERVICE_HANDLERS.get(context.operation);
  if (!handler) return false;
  await handler(context);
  return true;
}
