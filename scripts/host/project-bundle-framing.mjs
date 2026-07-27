import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { cleanDisplayName, DEFAULT_MAX_PDF_BYTES } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { WORKSPACE_NAMESPACES } from './workspace-state.mjs';

export const PROJECT_BUNDLE_SCHEMA_VERSION = 1;
export const PROJECT_BUNDLE_MAX_BYTES = 600 * 1024;
export const PROJECT_BUNDLE_MEDIA_TYPE = 'application/vnd.platen.project+json';
export const PORTABLE_PROJECT_BUNDLE_SCHEMA_VERSION = 1;
export const PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE = 'application/vnd.platen.portable-project';
export const PORTABLE_PROJECT_BUNDLE_EXTENSION = '.platen-project';
export const PORTABLE_PROJECT_BUNDLE_MAX_MANIFEST_BYTES = PROJECT_BUNDLE_MAX_BYTES;
export const PORTABLE_PROJECT_BUNDLE_MAX_BYTES = 20 + PORTABLE_PROJECT_BUNDLE_MAX_MANIFEST_BYTES + DEFAULT_MAX_PDF_BYTES;

const PORTABLE_MAGIC = Buffer.from('PLATENPROJECT\0\x01\r\n', 'latin1');
const PORTABLE_HEADER_BYTES = PORTABLE_MAGIC.length + 4;
const BUNDLE_KEYS = new Set(['schemaVersion', 'sourcePdfSha256', 'workspace', 'payloadSha256']);
const WORKSPACE_KEYS = new Set(['revision', 'namespaces', 'audit']);
const PORTABLE_KEYS = new Set(['schemaVersion', 'kind', 'source', 'workspace', 'payloadSha256']);
const PORTABLE_SOURCE_KEYS = new Set(['displayName', 'mediaType', 'size', 'sha256']);
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value) || Object.keys(value).length !== expected.size) fail('PROJECT_BUNDLE_INVALID', `${label} must have the required fields only.`);
  for (const key of expected) if (!Object.hasOwn(value, key)) fail('PROJECT_BUNDLE_INVALID', `${label} is missing required field ${key}.`);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail('PROJECT_BUNDLE_INVALID', `${label} contains an unknown field ${key}.`);
}

export function canonicalizeProjectBundle(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PROJECT_BUNDLE_INVALID', 'Project bundle contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeProjectBundle).join(',')}]`;
  if (!isPlainObject(value)) fail('PROJECT_BUNDLE_INVALID', 'Project bundle must contain JSON-safe plain data.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeProjectBundle(value[key])}`).join(',')}}`;
}

export function projectBundleDigest(value) { return createHash('sha256').update(value).digest('hex'); }
export function isProjectBundleDigest(value) { return SHA256.test(String(value ?? '')); }
export function freezeProjectBundle(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeProjectBundle(child);
  return Object.freeze(value);
}
export function snapshotProjectWorkspace(snapshot) {
  return { revision: snapshot.revision, namespaces: Object.fromEntries(WORKSPACE_NAMESPACES.map((namespace) => [namespace, snapshot.namespaces[namespace]])), audit: snapshot.audit };
}
export function createProjectBundle(sourcePdfSha256, workspace) {
  const payload = { schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION, sourcePdfSha256, workspace };
  return { ...payload, payloadSha256: projectBundleDigest(canonicalizeProjectBundle(payload)) };
}
export function validateProjectWorkspace(workspace) {
  assertExactKeys(workspace, WORKSPACE_KEYS, 'Project bundle workspace');
  if (!Number.isSafeInteger(workspace.revision) || workspace.revision < 0 || !isPlainObject(workspace.namespaces) || !Array.isArray(workspace.audit)) fail('PROJECT_BUNDLE_INVALID', 'Project bundle workspace is invalid.');
  const keys = Object.keys(workspace.namespaces);
  if (keys.length !== WORKSPACE_NAMESPACES.length || keys.some((key) => !WORKSPACE_NAMESPACES.includes(key)) || WORKSPACE_NAMESPACES.some((key) => !Array.isArray(workspace.namespaces[key]))) fail('PROJECT_BUNDLE_INVALID', 'Project bundle workspace namespaces are invalid.');
}
export function parseProjectBundle(input) {
  let raw;
  if (typeof input === 'string') raw = input;
  else if (Buffer.isBuffer(input)) { try { raw = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { fail('PROJECT_BUNDLE_INVALID_UTF8', 'Project bundle bytes must be valid UTF-8.'); } }
  else fail('PROJECT_BUNDLE_INVALID', 'Project bundle input must be canonical JSON text.');
  if (Buffer.byteLength(raw, 'utf8') > PROJECT_BUNDLE_MAX_BYTES) fail('PROJECT_BUNDLE_TOO_LARGE', 'Project bundle exceeds the local size limit.', 413);
  let bundle; try { bundle = JSON.parse(raw); } catch { fail('PROJECT_BUNDLE_INVALID_JSON', 'Project bundle is not valid JSON.'); }
  if (canonicalizeProjectBundle(bundle) !== raw) fail('PROJECT_BUNDLE_NONCANONICAL', 'Project bundle JSON must be canonical.');
  assertExactKeys(bundle, BUNDLE_KEYS, 'Project bundle');
  if (bundle.schemaVersion !== PROJECT_BUNDLE_SCHEMA_VERSION || !isProjectBundleDigest(bundle.sourcePdfSha256) || !isProjectBundleDigest(bundle.payloadSha256)) fail('PROJECT_BUNDLE_INVALID', 'Project bundle header is invalid.');
  validateProjectWorkspace(bundle.workspace);
  const payload = { schemaVersion: bundle.schemaVersion, sourcePdfSha256: bundle.sourcePdfSha256, workspace: bundle.workspace };
  if (projectBundleDigest(canonicalizeProjectBundle(payload)) !== bundle.payloadSha256) fail('PROJECT_BUNDLE_INTEGRITY_FAILED', 'Project bundle payload digest does not match its content.');
  return bundle;
}

function portablePayload(source, workspace) { return { schemaVersion: PORTABLE_PROJECT_BUNDLE_SCHEMA_VERSION, kind: 'portable-pdf-project', source, workspace }; }
export function createPortableProjectManifest(source, workspace) {
  const payload = portablePayload(source, workspace);
  return { ...payload, payloadSha256: projectBundleDigest(canonicalizeProjectBundle(payload)) };
}
export function parsePortableProjectManifest(bytes) {
  let raw; try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('PORTABLE_PROJECT_INVALID_UTF8', 'Portable project manifest must be valid UTF-8.'); }
  let manifest; try { manifest = JSON.parse(raw); } catch { fail('PORTABLE_PROJECT_INVALID_JSON', 'Portable project manifest is not valid JSON.'); }
  if (canonicalizeProjectBundle(manifest) !== raw) fail('PORTABLE_PROJECT_NONCANONICAL', 'Portable project manifest JSON must be canonical.');
  assertExactKeys(manifest, PORTABLE_KEYS, 'Portable project manifest');
  assertExactKeys(manifest.source, PORTABLE_SOURCE_KEYS, 'Portable project source');
  if (manifest.schemaVersion !== PORTABLE_PROJECT_BUNDLE_SCHEMA_VERSION || manifest.kind !== 'portable-pdf-project' || manifest.source.mediaType !== 'application/pdf' || !Number.isSafeInteger(manifest.source.size) || manifest.source.size < 1 || manifest.source.size > DEFAULT_MAX_PDF_BYTES || !isProjectBundleDigest(manifest.source.sha256) || typeof manifest.source.displayName !== 'string' || manifest.source.displayName !== cleanDisplayName(manifest.source.displayName) || Buffer.byteLength(manifest.source.displayName, 'utf8') > 200 || !isProjectBundleDigest(manifest.payloadSha256)) fail('PORTABLE_PROJECT_INVALID', 'Portable project manifest header is invalid.');
  validateProjectWorkspace(manifest.workspace);
  if (projectBundleDigest(canonicalizeProjectBundle(portablePayload(manifest.source, manifest.workspace))) !== manifest.payloadSha256) fail('PORTABLE_PROJECT_INTEGRITY_FAILED', 'Portable project manifest digest does not match its content.');
  return manifest;
}
export function portableProjectMagic() { return Buffer.from(PORTABLE_MAGIC); }
export function portableProjectHeaderBytes() { return PORTABLE_HEADER_BYTES; }
export function createPortableProjectPrefix(manifest) {
  const bytes = Buffer.from(canonicalizeProjectBundle(manifest), 'utf8');
  if (bytes.length < 1 || bytes.length > PORTABLE_PROJECT_BUNDLE_MAX_MANIFEST_BYTES) fail('PROJECT_BUNDLE_TOO_LARGE', 'Portable project manifest exceeds the local size limit.', 413);
  const header = Buffer.alloc(PORTABLE_HEADER_BYTES); PORTABLE_MAGIC.copy(header); header.writeUInt32BE(bytes.length, PORTABLE_MAGIC.length);
  return Buffer.concat([header, bytes]);
}
export function assertPortableProjectNotAborted(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Portable project processing was cancelled.', 499); }
export function createPortableProjectReader(stream, signal) {
  if (!stream?.[Symbol.asyncIterator]) fail('INVALID_BODY', 'A portable project request body is required.');
  const iterator = stream[Symbol.asyncIterator](); let pending = Buffer.alloc(0); let ended = false;
  const nextChunk = async () => { while (!ended) { assertPortableProjectNotAborted(signal); const next = await iterator.next(); if (next.done) { ended = true; return Buffer.alloc(0); } const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value); if (chunk.length) return chunk; } return Buffer.alloc(0); };
  return Object.freeze({
    async readExact(count) { const chunks = []; let size = 0; while (size < count) { if (!pending.length) pending = await nextChunk(); if (!pending.length) fail('PORTABLE_PROJECT_TRUNCATED', 'Portable project ended before its declared content.', 400); const take = Math.min(count - size, pending.length); chunks.push(pending.subarray(0, take)); pending = pending.subarray(take); size += take; } return Buffer.concat(chunks, count); },
    pdfStream(expectedBytes) { return (async function* exactPdf() { let remaining = expectedBytes; while (remaining > 0) { assertPortableProjectNotAborted(signal); if (!pending.length) pending = await nextChunk(); if (!pending.length) fail('PORTABLE_PROJECT_TRUNCATED', 'Portable project PDF bytes are truncated.', 400); const take = Math.min(remaining, pending.length); yield pending.subarray(0, take); pending = pending.subarray(take); remaining -= take; } if (pending.length) fail('PORTABLE_PROJECT_TRAILING_DATA', 'Portable project contains trailing bytes.', 400); while (!ended) { const extra = await nextChunk(); if (extra.length) fail('PORTABLE_PROJECT_TRAILING_DATA', 'Portable project contains trailing bytes.', 400); } }()); },
  });
}
