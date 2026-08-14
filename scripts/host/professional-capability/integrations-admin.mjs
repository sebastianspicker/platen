import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { result, fail, requireString, requireBytes, sha256 as shaBytes } from './support.mjs';
import { createTextPdf } from '../pdf-factory.mjs';
import { writeInertPageAnnotation } from './inert-annotation-writer.mjs';
import { assembleCadBimPdf } from './specialist-embed-pdf.mjs';
import {
  adminIdentityRoles,
  adminSsoScim,
  adminDeploymentPackaging,
  adminUpdateManagement,
  adminLicensing,
  adminPolicyConfiguration,
  adminDataResidency,
  adminUsageReporting,
  adminPluginAllowlist,
} from './integrations-admin-ops.mjs';
function denyNetwork(ctx) {
  if (ctx.remoteUrl || ctx.network === true || ctx.apiEndpoint || ctx.webhookUrl) {
    fail('NETWORK_FORBIDDEN', 'Integrations cannot open network endpoints in local-only mode.', 403);
  }
}
function sha(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export async function integrationsCloudStorage(ctx = {}) {
  denyNetwork(ctx);
  const root = ctx.root ?? join(tmpdir(), `pdf-cloud-local-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const name = requireString(ctx.objectName ?? 'doc.pdf', 'objectName', { min: 1, max: 120 });
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    fail('INVALID_OBJECT_NAME', 'objectName must be a single path segment.', 400);
  }
  const payload = Buffer.from(ctx.content ?? 'local-cloud-object', 'utf8');
  const path = join(root, name);
  await writeFile(path, payload, { mode: 0o600 });
  const got = await readFile(path);
  if (got.length !== payload.length) fail('CLOUD_INTEGRITY', 'put/get length mismatch', 502);
  const digest = createHash('sha256').update(got).digest('hex');
  if (digest !== createHash('sha256').update(payload).digest('hex')) {
    fail('CLOUD_INTEGRITY', 'put/get digest mismatch', 502);
  }
  return result('integrations.cloud-storage', {
    method: 'local-cloud-storage-filesystem',
    root,
    objectName: name,
    bytes: got.length,
    sha256: digest,
    network: false,
    put: true,
    get: true,
  });
}

export function integrationsOfficeAddins(ctx = {}) {
  denyNetwork(ctx);
  const version = requireString(ctx.version ?? '0.1.0', 'version', { min: 1, max: 40 });
  if (!/^\d+\.\d+\.\d+/.test(version)) fail('INVALID_VERSION', 'version must be semver-like', 400);
  const hosts = Array.isArray(ctx.hosts) ? ctx.hosts.map(String).slice(0, 10) : ['Word', 'Excel', 'PowerPoint'];
  const manifest = Object.freeze({
    id: 'platen.local.addin',
    version,
    hosts: Object.freeze([...hosts]),
    localOnly: true,
    permissions: Object.freeze(['readDocument', 'writeDocument']),
  });
  return result('integrations.office-addins', {
    method: 'local-office-addin-manifest',
    manifest,
    manifestSha256: sha(manifest),
  });
}

export function integrationsBrowserCapture(ctx = {}) {
  denyNetwork(ctx);
  const html = requireString(ctx.html ?? '<html><body>Capture</body></html>', 'html', { min: 1, max: 500_000 });
  if (/<script[\s>]/i.test(html) && ctx.allowScripts !== true) {
    fail('CAPTURE_SCRIPT_BLOCKED', 'Inline scripts require allowScripts=true (local review only).', 400);
  }
  const htmlSha256 = createHash('sha256').update(html).digest('hex');
  return result('integrations.browser-capture', {
    method: 'local-browser-html-capture-token',
    htmlSha256,
    bytes: Buffer.byteLength(html),
    captureReady: true,
    captureToken: htmlSha256.slice(0, 24),
  });
}

export function integrationsEmail(ctx = {}) {
  denyNetwork(ctx);
  const to = requireString(ctx.to ?? 'local@example.invalid', 'to', { min: 3, max: 200 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) fail('INVALID_EMAIL', 'to must look like an email', 400);
  const attachmentCount = Number.isSafeInteger(ctx.attachmentCount) ? ctx.attachmentCount : 1;
  if (attachmentCount < 0 || attachmentCount > 50) fail('INVALID_ATTACHMENTS', 'attachmentCount', 400);
  const draft = Object.freeze({
    to,
    subject: requireString(ctx.subject ?? 'PDF workbench attachment', 'subject', { min: 1, max: 200 }),
    attachmentCount,
    transport: 'local-draft-only',
    sent: false,
  });
  return result('integrations.email', {
    method: 'local-email-draft',
    draft,
    draftSha256: sha(draft),
  });
}

export function integrationsCadBim(ctx = {}) {
  denyNetwork(ctx);
  const entities = Array.isArray(ctx.entities)
    ? ctx.entities.slice(0, 500)
    : [{ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }];
  const built = assembleCadBimPdf({ entities });
  const latin1 = built.bytes.toString('latin1');
  if (!latin1.includes('CAD_BIM_EXPORT') && !latin1.includes('/PieceInfo')) {
    fail('CAD_BIM_EXPORT_MISSING', 'CAD/BIM export markers missing from PDF.', 502);
  }
  return result('integrations.cad-bim', {
    method: 'local-cad-bim-pdf-export',
    entities: Object.freeze(built.entities.map((e) => Object.freeze({ ...e }))),
    count: built.count,
    byType: Object.freeze(built.byType),
    digest: built.digest,
    applied: true,
    outputSha256: shaBytes(built.bytes),
    pdf: built.bytes,
    bytes: built.bytes.length,
  });
}

export function integrationsEsignProviders(ctx = {}) {
  denyNetwork(ctx);
  const providers = Array.isArray(ctx.providers)
    ? ctx.providers.slice(0, 20)
    : [{ id: 'local-esign', network: false }];
  for (const provider of providers) {
    if (provider?.network === true || provider?.remoteUrl) {
      fail('NETWORK_FORBIDDEN', 'Remote e-sign providers blocked.', 403);
    }
  }
  const registry = providers.map((p, i) => Object.freeze({
    id: String(p.id ?? `provider-${i}`),
    network: false,
    localAdapter: true,
  }));
  return result('integrations.esign-providers', {
    method: 'local-esign-provider-registry',
    providers: Object.freeze(registry),
    count: registry.length,
  });
}

export function integrationsSensitivityLabels(ctx = {}) {
  denyNetwork(ctx);
  const label = requireString(ctx.label ?? 'Internal', 'label', { min: 1, max: 80 });
  const allowed = new Set(['Public', 'Internal', 'Confidential', 'Restricted']);
  if (!allowed.has(label) && ctx.custom !== true) {
    fail('INVALID_LABEL', `label must be one of ${[...allowed].join(', ')} or custom=true`, 400);
  }
  const labelId = createHash('sha256').update(`sensitivity|${label}`).digest('hex').slice(0, 16);
  const source = ctx.sourcePdf
    ? requireBytes(ctx.sourcePdf, 'sourcePdf')
    : createTextPdf({ text: 'Sensitivity labeled document body', title: `Label:${label}` });
  const written = writeInertPageAnnotation(source, {
    subtype: 'Text',
    contents: `SENSITIVITY:${label}|${labelId}`,
    page: Number.isSafeInteger(ctx.page) ? ctx.page : 1,
    rect: [72, 720, 200, 780],
  });
  const latin1 = written.bytes.toString('latin1');
  if (!latin1.includes('/Subtype /Text') && !latin1.includes('/Subtype/Text')) {
    fail('LABEL_ANNOT_MISSING', 'Sensitivity label annotation missing.', 502);
  }
  return result('integrations.sensitivity-labels', {
    method: 'local-sensitivity-label-annotation',
    label,
    labelId,
    applied: true,
    sourceSha256: shaBytes(source),
    outputSha256: written.proof.outputSha256,
    pdf: written.bytes,
    bytes: written.bytes.length,
    proof: written.proof,
    annotationSubtype: 'Text',
  });
}

export function integrationsEventsWebhooks(ctx = {}) {
  denyNetwork(ctx);
  const events = Array.isArray(ctx.events) ? ctx.events.slice(0, 100) : [{ type: 'document.saved' }];
  if (events.length < 1) fail('INVALID_EVENTS', 'events required', 400);
  const outbox = events.map((event, index) => {
    const type = String(event?.type ?? event ?? 'unknown');
    return Object.freeze({
      index,
      type,
      transport: 'local-outbox',
      entrySha256: sha({ index, type }),
    });
  });
  return result('integrations.events-webhooks', {
    method: 'local-integration-event-bus',
    events: Object.freeze(events.map((e) => Object.freeze({ ...e }))),
    outbox: true,
    outboxEntries: Object.freeze(outbox),
    count: outbox.length,
  });
}

export const handlers = Object.freeze({
  async 'integrations.cloud-storage'(ctx = {}) { return integrationsCloudStorage(ctx); },
  async 'integrations.office-addins'(ctx = {}) { return integrationsOfficeAddins(ctx); },
  async 'integrations.browser-capture'(ctx = {}) { return integrationsBrowserCapture(ctx); },
  async 'integrations.email'(ctx = {}) { return integrationsEmail(ctx); },
  async 'integrations.cad-bim'(ctx = {}) { return integrationsCadBim(ctx); },
  async 'integrations.esign-providers'(ctx = {}) { return integrationsEsignProviders(ctx); },
  async 'integrations.sensitivity-labels'(ctx = {}) { return integrationsSensitivityLabels(ctx); },
  async 'integrations.events-webhooks'(ctx = {}) { return integrationsEventsWebhooks(ctx); },
  async 'admin.identity-roles'(ctx = {}) { return adminIdentityRoles(ctx); },
  async 'admin.sso-scim'(ctx = {}) { return adminSsoScim(ctx); },
  async 'admin.deployment-packaging'(ctx = {}) { return adminDeploymentPackaging(ctx); },
  async 'admin.update-management'(ctx = {}) { return adminUpdateManagement(ctx); },
  async 'admin.licensing'(ctx = {}) { return adminLicensing(ctx); },
  async 'admin.policy-configuration'(ctx = {}) { return adminPolicyConfiguration(ctx); },
  async 'admin.data-residency'(ctx = {}) { return adminDataResidency(ctx); },
  async 'admin.usage-reporting'(ctx = {}) { return adminUsageReporting(ctx); },
  async 'admin.plugin-allowlist'(ctx = {}) { return adminPluginAllowlist(ctx); },
});
