import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginSandboxStatusService } from '../scripts/host/plugin-sandbox-status-service.mjs';
import { handlePluginPlatformRoute } from '../scripts/host/routes/plugin-platform-routes.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { invoke } from './support/host-router-fixture-base.js';

const routeToken = 'a'.repeat(64);

function sandboxService(inspect) {
  return new PluginSandboxStatusService({
    inspect,
    runner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
}

function createHandler(pluginSandboxStatus) {
  return createAppHandler({
    staticHandler: () => {},
    store: {
      deleteArtifact: async () => {},
      getDocument: () => null,
      verifySource: async () => {},
    },
    service: { availability: async () => [] },
    workspaceState: {},
    pluginSandboxStatus,
    token: routeToken,
    host: '127.0.0.1',
    port: 4173,
  });
}

function handlerFetch(handler) {
  return async (path, options = {}) => {
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
  };
}

test('authenticated client receives one cached blocked sandbox diagnostic without plugin input', async () => {
  let calls = 0;
  const statusService = sandboxService(async () => {
    calls += 1;
    return {
      available: true,
      bestEffort: {
        sandboxBehaviorProbe: true,
        filesystemWriteDenied: true,
        sensitiveFilesystemReadDenied: true,
        networkCanaryDenied: true,
        processForkCanaryDenied: true,
        nodePermissionProbe: true,
        cpuLimitCanary: true,
        jitless: true,
      },
      rawProfile: '(allow default)',
      localPath: '/private/diagnostic-only',
    };
  });
  const handler = createHandler(statusService);

  const unauthorized = await invoke(handler, {
    method: 'POST',
    url: '/api/plugin-sandbox-probe',
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls, 0);

  const client = new LocalHostClient({ fetchImpl: handlerFetch(handler) });
  await client.bootstrap();
  const first = await client.runPluginSandboxProbe();
  const second = await client.runPluginSandboxProbe();
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(first.kind, 'plugin-sandbox-status');
  assert.equal(first.status, 'blocked');
  assert.equal(first.executionReady, false);
  assert.equal(first.pluginCodeExecuted, false);
  assert.equal(first.cacheScope, 'host-session');
  assert.equal(first.probeAvailable, true);
  assert.equal(Object.values(first.hardControls).every((value) => value === false), true);
  assert.equal(first.reasonCode, 'BEST_EFFORT_CANARIES_PASSED');
  assert.equal(Object.hasOwn(first, 'rawProfile'), false);
  assert.equal(JSON.stringify(first).includes('/private/diagnostic-only'), false);
});

test('pre-cancelled sandbox route rejects before starting the cached diagnostic', async () => {
  let calls = 0;
  const statusService = sandboxService(async () => {
    calls += 1;
    return { available: false };
  });
  const controller = new AbortController();
  controller.abort();
  const context = {
    pathname: '/api/plugin-sandbox-probe',
    request: { method: 'POST' },
    response: {},
    url: new URL('http://127.0.0.1/api/plugin-sandbox-probe'),
    processing: { signal: controller.signal },
    pluginSandboxStatus: statusService,
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => ({}),
    json: () => { throw new Error('cancelled route must not write'); },
  };
  await assert.rejects(
    handlePluginPlatformRoute(context),
    { code: 'JOB_CANCELLED', status: 499 },
  );
  assert.equal(calls, 0);
});
