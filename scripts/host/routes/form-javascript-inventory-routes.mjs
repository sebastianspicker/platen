import { HostError } from '../host-error.mjs';
import { PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE, normalizePdfFormJavaScriptInventoryRequest } from '../pdf-form-javascript-contract.mjs';
import { validateFormJavaScriptInventoryResult } from '../../../src/core/local-host-form-javascript-inventory-endpoints.js';

const SHA256 = /^[0-9a-f]{64}$/u;

export async function handleFormJavaScriptInventoryRoute({
  request, response, url, operation, documentId, processing, formJavaScriptInventory,
  bodyLimit, exactJsonObject, method, readJson, json,
}) {
  if (operation !== 'form-javascript-inventory') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Form JavaScript inventory does not accept query parameters.', 400);
  }
  if (!formJavaScriptInventory || typeof formJavaScriptInventory.inspect !== 'function') {
    throw new HostError('PDF_FORM_JAVASCRIPT_INVENTORY_UNAVAILABLE', 'Form JavaScript inventory is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256'])
    || body.profile !== PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE || !SHA256.test(body.sourceSha256 ?? '')) {
    throw new HostError('PDF_FORM_JAVASCRIPT_OPTIONS_INVALID', 'Form JavaScript inventory requires the fixed profile and current lowercase source SHA-256.', 400);
  }
  try {
    normalizePdfFormJavaScriptInventoryRequest(body);
  } catch (error) {
    throw new HostError('PDF_FORM_JAVASCRIPT_OPTIONS_INVALID', 'Form JavaScript inventory options are outside the bounded canonical contract.', 400, { cause: error });
  }
  const result = await formJavaScriptInventory.inspect(documentId, body, { signal: processing.signal });
  try { validateFormJavaScriptInventoryResult(result, body.sourceSha256); } catch (error) {
    throw new HostError('PDF_FORM_JAVASCRIPT_OUTPUT_INVALID', 'Form JavaScript inventory returned invalid privacy-safe evidence.', 502, { cause: error });
  }
  json(response, 200, { result });
  return true;
}

export const handlePdfFormJavaScriptInventoryRoute = handleFormJavaScriptInventoryRoute;
