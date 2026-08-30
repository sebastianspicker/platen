import { HostError } from '../../../platform/runtime/host-error.mjs';
import { collectSelectedExtensionMetadataCatalog } from '../../../application/plugins/selected-extension-metadata-catalog.mjs';
import { PACKAGE_LIMITS, PLUGIN_ID, SEMVER } from '../../../application/plugins/plugin-package-contract.mjs';

function isExactEmptyObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0;
}

function pluginPath(pathname) {
  const match = /^\/api\/plugin-packages\/([^/]+)\/(select|rollback)$/u.exec(pathname);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { throw new HostError('INVALID_PARAMETER', 'Plugin ID is invalid.', 400); }
  if (!PLUGIN_ID.test(id)) throw new HostError('INVALID_PARAMETER', 'Plugin ID is invalid.', 400);
  return { id, action: match[2] };
}

function selectionResult(action, result) {
  return Object.freeze({ action, result, localOnly: true });
}

async function handlePackageSelectionRoute({ pathname, request, response, url, processing, pluginPackages, method, readJson, readBytes, requireContentType, json }) {
  if (pathname === '/api/plugin-capability-catalog') {
    method(request, 'GET');
    if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Plugin capability catalog listing does not accept query parameters.', 400);
    if (!pluginPackages) throw new HostError('PLUGIN_PACKAGE_UNAVAILABLE', 'Plugin package management is unavailable.', 503);
    json(response, 200, await collectSelectedExtensionMetadataCatalog(pluginPackages, { signal: processing.signal }));
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
      json(response, 201, selectionResult('install', result));
    } finally { bytes.fill(0); }
    return true;
  }
  const target = pluginPath(pathname);
  if (!target) return false;
  method(request, 'POST');
  if (!pluginPackages) throw new HostError('PLUGIN_PACKAGE_UNAVAILABLE', 'Plugin package management is unavailable.', 503);
  requireContentType(request, 'application/json');
  if (!isExactEmptyObject(await readJson(request, 256))) {
    throw new HostError('INVALID_PLUGIN_PACKAGE_REQUEST', 'Plugin package selection actions require an empty JSON object.', 400);
  }
  if (target.action === 'select') {
    if (url.searchParams.size !== 1 || !url.searchParams.has('version') || !SEMVER.test(url.searchParams.get('version') ?? '')) {
      throw new HostError('INVALID_PARAMETER', 'Plugin selection requires only a valid version query parameter.', 400);
    }
    if (processing.signal.aborted) throw new HostError('JOB_CANCELLED', 'Plugin selection was cancelled.', 499);
    await pluginPackages.select(target.id, url.searchParams.get('version'));
    json(response, 200, selectionResult('select', pluginPackages.getPlugin(target.id)));
    return true;
  }
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Plugin rollback does not accept query parameters.', 400);
  if (processing.signal.aborted) throw new HostError('JOB_CANCELLED', 'Plugin rollback was cancelled.', 499);
  await pluginPackages.rollback(target.id);
  json(response, 200, selectionResult('rollback', pluginPackages.getPlugin(target.id)));
  return true;
}

export async function handlePluginPlatformRoute(context) {
  return handlePackageSelectionRoute(context);
}
