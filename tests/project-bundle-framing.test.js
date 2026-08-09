import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeProjectBundle,
  createPortableProjectManifest,
  createProjectBundle,
  parsePortableProjectManifest,
  parseProjectBundle,
} from '../scripts/host/project-bundle-framing.mjs';
import { WORKSPACE_NAMESPACES } from '../scripts/host/workspace-state.mjs';

const digest = 'a'.repeat(64);

function workspace() {
  return { revision: 0, namespaces: Object.fromEntries(WORKSPACE_NAMESPACES.map((namespace) => [namespace, []])), audit: [] };
}

function projectBundle() { return createProjectBundle(digest, workspace()); }

function portableManifest() {
  return createPortableProjectManifest({ displayName: 'source.pdf', mediaType: 'application/pdf', size: 123, sha256: digest }, workspace());
}

function canonical(value) { return canonicalizeProjectBundle(value); }

test('project bundle and portable manifest accept their canonical JSON representations', () => {
  const bundle = projectBundle();
  const manifest = portableManifest();
  assert.equal(canonical({ z: [true, null], a: { y: 1, x: 'value' } }), '{"a":{"x":"value","y":1},"z":[true,null]}');
  assert.deepEqual(parseProjectBundle(canonical(bundle)), bundle);
  assert.deepEqual(parseProjectBundle(Buffer.from(canonical(bundle))), bundle);
  assert.deepEqual(parsePortableProjectManifest(Buffer.from(canonical(manifest))), manifest);
});

test('project bundle and portable manifest reject invalid UTF-8 and JSON with their distinct contracts', () => {
  assert.throws(() => parseProjectBundle(Buffer.from([0x80])), { code: 'PROJECT_BUNDLE_INVALID_UTF8', status: 400 });
  assert.throws(() => parsePortableProjectManifest(Buffer.from([0x80])), { code: 'PORTABLE_PROJECT_INVALID_UTF8', status: 400 });
  assert.throws(() => parseProjectBundle('{'), { code: 'PROJECT_BUNDLE_INVALID_JSON', status: 400 });
  assert.throws(() => parsePortableProjectManifest(Buffer.from('{')), { code: 'PORTABLE_PROJECT_INVALID_JSON', status: 400 });
});

test('project bundle and portable manifest reject noncanonical JSON and exact-key violations', () => {
  const bundle = projectBundle();
  const manifest = portableManifest();
  assert.throws(() => parseProjectBundle(JSON.stringify(bundle)), { code: 'PROJECT_BUNDLE_NONCANONICAL', status: 400 });
  assert.throws(() => parsePortableProjectManifest(Buffer.from(JSON.stringify(manifest))), { code: 'PORTABLE_PROJECT_NONCANONICAL', status: 400 });
  assert.throws(() => parseProjectBundle(canonical({ ...bundle, extra: true })), { code: 'PROJECT_BUNDLE_INVALID', status: 400 });
  assert.throws(() => parsePortableProjectManifest(Buffer.from(canonical({ ...manifest, extra: true }))), { code: 'PROJECT_BUNDLE_INVALID', status: 400 });
});

test('portable manifest validates the source header before the payload digest', () => {
  const manifest = portableManifest();
  const invalidSource = createPortableProjectManifest({ ...manifest.source, size: 0 }, manifest.workspace);
  assert.throws(() => parsePortableProjectManifest(Buffer.from(canonical(invalidSource))), { code: 'PORTABLE_PROJECT_INVALID', status: 400 });
});

test('project bundle and portable manifest retain digest-mismatch parity', () => {
  const bundle = { ...projectBundle(), workspace: { ...workspace(), revision: 1 } };
  const manifest = { ...portableManifest(), workspace: { ...workspace(), revision: 1 } };
  assert.throws(() => parseProjectBundle(canonical(bundle)), { code: 'PROJECT_BUNDLE_INTEGRITY_FAILED', status: 400 });
  assert.throws(() => parsePortableProjectManifest(Buffer.from(canonical(manifest))), { code: 'PORTABLE_PROJECT_INTEGRITY_FAILED', status: 400 });
});
