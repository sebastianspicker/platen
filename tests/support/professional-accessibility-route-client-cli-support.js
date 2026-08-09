import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { DocumentStore } from '../../scripts/host/document-store.mjs';
import { createProfessionalAccessibilityDelivery } from '../../scripts/host/professional-accessibility-delivery.mjs';
import { accessibilityFormSemantics } from '../../scripts/host/professional-capability/accessibility-ops-form.mjs';
import { accessibilityLinksBookmarks } from '../../scripts/host/professional-capability/accessibility-ops-extra.mjs';
import { accessibilityTableSemantics } from '../../scripts/host/professional-capability/accessibility-ops.mjs';

export { assert };
export const HANDLERS = Object.freeze({
  'accessibility.form-semantics': accessibilityFormSemantics,
  'accessibility.table-semantics': accessibilityTableSemantics,
  'accessibility.links-bookmarks': accessibilityLinksBookmarks,
});
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function formRequest(sourcePdf) {
  const sourceSha256 = digest(sourcePdf);
  return { profile: 'local-accessibility-form-semantics-v1', sourceSha256,
    fields: [0, 1, 2].map((annotationIndex, tabIndex) => ({
      target: { page: 1, annotationIndex, fingerprint: digest(Buffer.from([
        'pdfkit-inspector:opaque-locator:v1', `source-sha256=${sourceSha256}`,
        'page=1', `annotation-index=${annotationIndex}`, 'subtype=widget', 'widget-type=button',
      ].join('\n'))) },
      role: 'button', name: `Field ${annotationIndex}`, tooltip: `Field tooltip ${annotationIndex}`, tabIndex,
    })),
  };
}
export async function initializedStore(t, label) {
  const root = await mkdtemp(`/private/tmp/platen-professional-accessibility-${label}-`);
  const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose()); return store;
}
export function addDocument(store, sourcePdf) {
  return store.createDocument({ stream: (async function* stream() { yield sourcePdf; }()), displayName: 'source.pdf' });
}
export function delivery(store, services, deliver = async (capabilityId, context) => HANDLERS[capabilityId](context)) {
  return createProfessionalAccessibilityDelivery({ store, services, deliver, list: () => Object.keys(HANDLERS) });
}
export function exactJsonObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function routeContext({ operation, documentId, request, professionalCapabilities, store, aborted = false }) {
  const response = new EventEmitter(); response.destroyed = aborted; response.writableEnded = false;
  const controller = new AbortController(); if (aborted) controller.abort();
  return { context: { operation, request: { method: 'POST' }, response, url: new URL(`http://127.0.0.1/api/documents/${documentId}/${operation}`), documentId, processing: { signal: controller.signal }, store, professionalCapabilities, bodyLimit: 128 * 1024, exactJsonObject, method: (actual, expected) => assert.equal(actual.method, expected), readJson: async () => structuredClone(request), json: (_response, status, body) => { response.status = status; response.body = body; } }, response };
}
