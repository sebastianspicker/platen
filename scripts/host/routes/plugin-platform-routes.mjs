import { HostError } from '../host-error.mjs';
import { collectActivePluginCapabilityCatalog } from '../plugin-active-capability-catalog.mjs';
import { PACKAGE_LIMITS, PLUGIN_ID, SEMVER } from '../plugin-package-contract.mjs';
import { validatePluginSandboxStatus } from '../../../src/core/plugin-sandbox-status-contract.js';

const PLUGIN_SANDBOX_PROBE_BODY_LIMIT = 256;

function isExactEmptyObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0;
}

function pluginPath(pathname) {
  const match = /^\/api\/plugin-packages\/([^/]+)\/(activate|rollback)$/u.exec(pathname);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { throw new HostError('INVALID_PARAMETER', 'Plugin ID is invalid.', 400); }
  if (!PLUGIN_ID.test(id)) throw new HostError('INVALID_PARAMETER', 'Plugin ID is invalid.', 400);
  return { id, action: match[2] };
}

function lifecycleResult(action, result) {
  return Object.freeze({ action, result, localOnly: true });
}

async function handlePackageLifecycleRoute({ pathname, request, response, url, processing, pluginPackages, method, readJson, readBytes, requireContentType, json }) {
  if (pathname === '/api/plugin-capability-catalog') {
    method(request, 'GET');
    if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Plugin capability catalog listing does not accept query parameters.', 400);
    if (!pluginPackages) throw new HostError('PLUGIN_PACKAGE_UNAVAILABLE', 'Plugin package management is unavailable.', 503);
    json(response, 200, await collectActivePluginCapabilityCatalog(pluginPackages, { signal: processing.signal }));
    return true;
  }
  if (pathname === '/api/plugin-packages') {
    method(request, 'GET');
    if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Plugin package listing does not accept query parameters.', 400);
    if (!pluginPackages || typeof pluginPackages.listPlugins !== 'function') throw new HostError('PLUGIN_PACKAGE_UNAVAILABLE', 'Plugin package management is unavailable.', 503);
    json(response, 200, { plugins: pluginPackages.listPlugins() });
    return true;
  }
  if (pathname === '/api/plugin-packages/install') {
    method(request, 'POST');
    if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Plugin package installation does not accept query parameters.', 400);
    if (!pluginPackages || typeof pluginPackages.install !== 'function') throw new HostError('PLUGIN_PACKAGE_UNAVAILABLE', 'Plugin package management is unavailable.', 503);
    requireContentType(request, 'application/json');
    const bytes = await readBytes(request, PACKAGE_LIMITS.maxEncodedBytes);
    try {
      if (processing.signal.aborted) throw new HostError('JOB_CANCELLED', 'Plugin package installation was cancelled.', 499);
      const result = await pluginPackages.install(bytes);
      json(response, 201, lifecycleResult('install', result));
    } finally { bytes.fill(0); }
    return true;
  }
  const target = pluginPath(pathname);
  if (!target) return false;
  method(request, 'POST');
  if (!pluginPackages) throw new HostError('PLUGIN_PACKAGE_UNAVAILABLE', 'Plugin package management is unavailable.', 503);
  requireContentType(request, 'application/json');
  if (!isExactEmptyObject(await readJson(request, 256))) {
    throw new HostError('INVALID_PLUGIN_PACKAGE_REQUEST', 'Plugin package lifecycle actions require an empty JSON object.', 400);
  }
  if (target.action === 'activate') {
    if (url.searchParams.size !== 1 || !url.searchParams.has('version') || !SEMVER.test(url.searchParams.get('version') ?? '')) {
      throw new HostError('INVALID_PARAMETER', 'Plugin activation requires only a valid version query parameter.', 400);
    }
    if (processing.signal.aborted) throw new HostError('JOB_CANCELLED', 'Plugin activation was cancelled.', 499);
    await pluginPackages.activate(target.id, url.searchParams.get('version'));
    json(response, 200, lifecycleResult('activate', pluginPackages.getPlugin(target.id)));
    return true;
  }
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Plugin rollback does not accept query parameters.', 400);
  if (processing.signal.aborted) throw new HostError('JOB_CANCELLED', 'Plugin rollback was cancelled.', 499);
  await pluginPackages.rollback(target.id);
  json(response, 200, lifecycleResult('rollback', pluginPackages.getPlugin(target.id)));
  return true;
}

export async function handlePluginPlatformRoute(context) {
  const { pathname, request, response, url, pluginSandboxStatus, method, readJson, json } = context;
  if (await handlePackageLifecycleRoute(context)) return true;
  if (pathname !== '/api/plugin-sandbox-probe') return false;

  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Plugin sandbox probing does not accept query parameters.', 400);
  }
  if (!pluginSandboxStatus || typeof pluginSandboxStatus.getStatus !== 'function') {
    throw new HostError('PLUGIN_SANDBOX_PROBE_UNAVAILABLE', 'Plugin sandbox probing is unavailable.', 503);
  }
  if (!isExactEmptyObject(await readJson(request, PLUGIN_SANDBOX_PROBE_BODY_LIMIT))) {
    throw new HostError('INVALID_PLUGIN_SANDBOX_PROBE', 'Plugin sandbox probing requires an empty JSON object.', 400);
  }
  json(response, 200, validatePluginSandboxStatus(await pluginSandboxStatus.getStatus({
    signal: context.processing.signal,
  })));
  return true;
}
