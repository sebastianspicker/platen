import {
  DEFAULT_PLUGIN_TRANSPORT_MAX_CONCURRENT_REQUESTS,
  MAX_PLUGIN_TRANSPORT_CONCURRENT_REQUESTS,
  preparePluginRpcTransport,
} from './plugin-rpc-transport-setup.mjs';
import { runPreparedPluginRpcTransport } from './plugin-rpc-transport-runtime.mjs';

export { DEFAULT_PLUGIN_TRANSPORT_MAX_CONCURRENT_REQUESTS, MAX_PLUGIN_TRANSPORT_CONCURRENT_REQUESTS };

export async function runPluginRpcTransport(options = {}) {
  const prepared = preparePluginRpcTransport(options);
  return runPreparedPluginRpcTransport({ ...options, ...prepared });
}
