import {
  handlePdfkitInspection,
  handlePdfkitMutation,
  handlePdfkitProtection,
  handlePdfkitProtectionRemoval,
  handlePdfkitSanitization,
  handlePdfkitSplitOutline,
  handlePdfkitTextFieldWidget,
} from './pdfkit-route-handlers.mjs';

const PDFKIT_HANDLERS = new Map([
  ['pdfkit-inspection', handlePdfkitInspection],
  ['split-outline', handlePdfkitSplitOutline],
  ['pdfkit-mutation', handlePdfkitMutation],
  ['pdfkit-text-field-widget', handlePdfkitTextFieldWidget],
  ['pdfkit-protection', handlePdfkitProtection],
  ['pdfkit-protection-removal', handlePdfkitProtectionRemoval],
  ['sanitization', handlePdfkitSanitization],
]);

export async function handlePdfkitRoute(context) {
  const handler = PDFKIT_HANDLERS.get(context.operation);
  if (!handler) return false;
  await handler(context);
  return true;
}
