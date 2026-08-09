import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LocalHostClient } from '../src/core/local-host-client.js';
import { handlePluginPlatformRoute } from '../scripts/host/routes/plugin-platform-routes.mjs';
import { canonicalizePluginPackage, pluginPackageSignedPayload, sha256, TrustedPublisherStore } from '../scripts/host/plugin-package.mjs';
import { PluginPackageStore } from '../scripts/host/plugin-package-store.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const pluginId = 'org.example.verification';
const routeToken = 'a'.repeat(64);
const keys = generateKeyPairSync('ed25519');

function trust(pluginIds = [pluginId]) {
  const trustedPublishers = new TrustedPublisherStore();
  trustedPublishers.enroll({
    publisherId: 'org.example',
    keyId: 'test-key',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    pluginIds,
  });
  return trustedPublishers;
}

function signedExecutablePackage({
  id = pluginId,
  source = 'throw new Error("plugin source must not execute");',
} = {}) {
  const content = Buffer.from(source);
  const value = {
    packageVersion: 1,
    manifest: {
      manifestVersion: 3,
      id,
      name: 'Verification package',
      version: '1.0.0',
      protocolVersion: 1,
      entry: 'index.js',
      capabilities: ['document.metadata'],
      permissions: [{ name: 'document.metadata', reason: 'Read document metadata locally.' }],
      dependencies: [],
      activation: 'manual',
      runtime: { kind: 'javascriptcore-classic-script', apiVersion: 1 },
    },
    files: [{
      path: 'index.js',
      mediaType: 'text/javascript',
      size: content.length,
      sha256: sha256(content),
      content: content.toString('base64'),
    }],
    signature: {
      algorithm: 'ed25519',
      publisherId: 'org.example',
      keyId: 'test-key',
      value: '',
    },
  };
  value.signature.value = sign(null, Buffer.from(pluginPackageSignedPayload(value)), keys.privateKey).toString('base64');
  return value;
}

function corruptSignature(value) {
  const packageValue = structuredClone(value);
  const bytes = Buffer.from(packageValue.signature.value, 'base64');
  bytes[0] ^= 0xff;
  packageValue.signature.value = bytes.toString('base64');
  return packageValue;
}

function untrustedPublisher(value) {
  const packageValue = structuredClone(value);
  packageValue.signature.publisherId = 'org.untrusted';
  packageValue.signature.keyId = 'rogue-key';
  packageValue.signature.value = sign(
    null,
    Buffer.from(pluginPackageSignedPayload(packageValue)),
    keys.privateKey,
  ).toString('base64');
  return packageValue;
}

function encodeCanonical(value) {
  return Buffer.from(canonicalizePluginPackage(value), 'utf8');
}

function routeHandler({ store }) {
  return createAppHandler({
    staticHandler: () => {},
    store: {
      deleteArtifact: async () => {},
      getDocument: () => null,
      verifySource: async () => {},
    },
    service: { availability: async () => [] },
    workspaceState: {},
    pluginPackages: store,
    token: routeToken,
    host: '127.0.0.1',
    port: 4173,
  });
}

function createClient(handler) {
  return new LocalHostClient({
    fetchImpl: async (path, options = {}) => {
      const headers = Object.fromEntries(
        Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const response = await invoke(handler, {
        method: options.method ?? 'GET',
        url: path,
        headers: { origin: 'http://127.0.0.1:4173', ...headers },
        body: options.body ?? '',
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  });
}

async function createStore(context, pluginIds = [pluginId]) {
  const root = await mkdtemp(join(tmpdir(), 'platen-plugin-package-verification-'));
  context.after(async () => {
    for (const digest of await readdir(join(root, 'packages')).catch(() => [])) {
      await chmod(join(root, 'packages', digest), 0o700).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  const trusted = trust(pluginIds);
  const store = await new PluginPackageStore({ root, trustedPublishers: trusted }).initialize();
  return { root, store };
}

async function invokeInstall(handler, bytes, { includeToken = true } = {}) {
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/plugin-packages/install',
    headers: {
      origin: 'http://127.0.0.1:4173',
      ...(includeToken ? { 'content-type': 'application/json', 'x-platen-token': routeToken } : { 'content-type': 'application/json' }),
    },
    body: bytes,
  });
  const payload = JSON.parse(response.body.toString('utf8'));
  return { response, payload };
}

function assertSanitizedLifecycle(value) {
  assert.deepEqual(Object.keys(value).sort(), ['digest', 'id', 'version']);
  assert.equal(Object.hasOwn(value, 'signature'), false);
  assert.equal(Object.hasOwn(value, 'manifest'), false);
  assert.equal(Object.hasOwn(value, 'packages'), false);
}

function assertNoWireLeak(body) {
  assert.equal(Object.keys(body).length, 1);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  assert.equal(Object.hasOwn(body.error, 'path'), false);
  assert.equal(Object.hasOwn(body.error, 'signature'), false);
}

test('unauthenticated plugin install route rejects before store mutation', async (context) => {
  const { store } = await createStore(context);
  const handler = routeHandler({ store });
  const payload = signedExecutablePackage();
  const before = store.listPlugins();
  const response = await invokeInstall(handler, encodeCanonical(payload), { includeToken: false });
  assert.equal(response.response.statusCode, 401);
  assert.equal(response.payload.error.code, 'UNAUTHORIZED');
  assert.deepEqual(store.listPlugins(), before);
});

test('authenticated LocalHostClient install of canonical bytes succeeds and returns only id/version/digest', async (context) => {
  const { store } = await createStore(context);
  const handler = routeHandler({ store });
  const client = createClient(handler);
  await client.bootstrap();
  const result = await client.installPluginPackage(encodeCanonical(signedExecutablePackage()));
  assertSanitizedLifecycle(result);
  assert.equal(result.id, pluginId);
  assert.equal(result.version, '1.0.0');
  const plugin = store.getPlugin(pluginId);
  assert.equal(plugin.versions.length, 1);
  assert.equal(plugin.versions[0].digest, result.digest);
});

test('invalid signature and untrusted publisher install attempts fail safely without registry mutation', async (context) => {
  const { store } = await createStore(context);
  const handler = routeHandler({ store });
  const valid = signedExecutablePackage();

  const invalidSignature = corruptSignature(valid);
  const invalidResponse = await invokeInstall(handler, encodeCanonical(invalidSignature));
  assert.equal(invalidResponse.response.statusCode, 400);
  assert.equal(invalidResponse.payload.error.code, 'PACKAGE_SIGNATURE_INVALID');
  assertNoWireLeak(invalidResponse.payload);

  const untrusted = untrustedPublisher(valid);
  const untrustedResponse = await invokeInstall(handler, encodeCanonical(untrusted));
  assert.equal(untrustedResponse.response.statusCode, 403);
  assert.equal(untrustedResponse.payload.error.code, 'PUBLISHER_UNTRUSTED');
  assertNoWireLeak(untrustedResponse.payload);
  assert.equal(store.listPlugins().length, 0);
});

test('pre-cancelled direct install route fails JOB_CANCELLED before installation writes occur', async (context) => {
  const { store } = await createStore(context);
  const bytes = encodeCanonical(signedExecutablePackage());
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    handlePluginPlatformRoute({
      pathname: '/api/plugin-packages/install',
      request: { method: 'POST' },
      response: {},
      url: new URL('http://127.0.0.1/api/plugin-packages/install'),
      processing: { signal: controller.signal },
      pluginPackages: store,
      method: (request, expected) => assert.equal(request.method, expected),
      readJson: async () => ({}),
      readBytes: async () => bytes,
      requireContentType: () => {},
      json: () => { throw new Error('cancelled route must not write response'); },
    }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
  assert.equal(store.listPlugins().length, 0);
});

test('tampering with retained executable bytes after install causes activation integrity failure', async (context) => {
  const { store } = await createStore(context);
  const handler = routeHandler({ store });
  const client = createClient(handler);
  await client.bootstrap();
  const packageValue = signedExecutablePackage();
  const installation = await client.installPluginPackage(encodeCanonical(packageValue));
  await client.activatePluginPackage(pluginId, installation.version);

  const entry = join(store.root, 'packages', installation.digest, 'index.js');
  await chmod(entry, 0o600);
  await writeFile(entry, 'globalThis.wasTampered = true;', 'utf8');

  await assert.rejects(client.activatePluginPackage(pluginId, installation.version), {
    code: 'PACKAGE_INTEGRITY_FAILED',
  });
});
