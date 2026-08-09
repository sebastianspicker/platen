import { HostError } from '../host-error.mjs';
import { normalizePdfAccessibilityFormSemantics } from '../pdf-accessibility-form-semantics-contract.mjs';
import { normalizePdfAccessibilityLinksBookmarks } from '../pdf-accessibility-links-bookmarks-contract.mjs';
import { normalizePdfAccessibilityTableSemantics } from '../pdf-accessibility-table-semantics-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const ROUTES = Object.freeze({
  'accessibility-form-semantics': Object.freeze({
    capabilityId: 'accessibility.form-semantics',
    keys: Object.freeze(['profile', 'sourceSha256', 'fields']),
    normalize: normalizePdfAccessibilityFormSemantics,
  }),
  'accessibility-table-semantics': Object.freeze({
    capabilityId: 'accessibility.table-semantics',
    keys: Object.freeze(['profile', 'sourceSha256', 'table']),
    normalize: normalizePdfAccessibilityTableSemantics,
  }),
  'accessibility-links-bookmarks': Object.freeze({
    capabilityId: 'accessibility.links-bookmarks',
    keys: Object.freeze(['profile', 'sourceSha256', 'links', 'bookmarks']),
    normalize: normalizePdfAccessibilityLinksBookmarks,
  }),
});

const INVENTORY_ROUTES = Object.freeze({
  'accessibility-table-semantics-inventory': 'accessibility.table-semantics',
  'accessibility-links-bookmarks-inventory': 'accessibility.links-bookmarks',
});

export async function handleProfessionalAccessibilityRoute(context) {
  const inventoryCapabilityId = INVENTORY_ROUTES[context.operation];
  if (inventoryCapabilityId) {
    const {
      request, response, url, documentId, processing, professionalCapabilities,
      bodyLimit, exactJsonObject, method, readJson, json,
    } = context;
    method(request, 'POST');
    if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Professional accessibility locator inventory does not accept query parameters.', 400);
    if (!professionalCapabilities || typeof professionalCapabilities.inventorySourceBound !== 'function') {
      throw new HostError('PROFESSIONAL_ACCESSIBILITY_UNAVAILABLE', 'Professional accessibility locator inventory is unavailable.', 503);
    }
    const body = await readJson(request, bodyLimit);
    if (!exactJsonObject(body, ['sourceSha256']) || !/^[0-9a-f]{64}$/u.test(body.sourceSha256 ?? '')) {
      throw new HostError('PROFESSIONAL_ACCESSIBILITY_OPTIONS_INVALID', 'Professional accessibility locator inventory requires its exact source digest.', 400);
    }
    const result = await professionalCapabilities.inventorySourceBound(
      inventoryCapabilityId, documentId, body, { signal: processing.signal },
    );
    json(response, 200, { result });
    return true;
  }
  const descriptor = ROUTES[context.operation];
  if (!descriptor) return false;
  const {
    request, response, url, documentId, processing, store, professionalCapabilities,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Professional accessibility repair does not accept query parameters.', 400);
  }
  if (!professionalCapabilities || typeof professionalCapabilities.deliverSourceBound !== 'function') {
    throw new HostError('PROFESSIONAL_ACCESSIBILITY_UNAVAILABLE', 'Professional accessibility delivery is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, descriptor.keys)) {
    throw new HostError('PROFESSIONAL_ACCESSIBILITY_OPTIONS_INVALID', 'Professional accessibility repair requires its exact source-bound request fields.', 400);
  }
  let normalized;
  try {
    normalized = descriptor.normalize(body);
  } catch (error) {
    throw new HostError('PROFESSIONAL_ACCESSIBILITY_OPTIONS_INVALID', 'The professional accessibility request is outside the bounded contract.', 400, { cause: error });
  }
  const result = await professionalCapabilities.deliverSourceBound(
    descriptor.capabilityId,
    documentId,
    normalized,
    { signal: processing.signal },
  );
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  const { pdf: _pdf, ...publicResult } = result;
  json(response, 201, { result: publicResult });
  return true;
}
