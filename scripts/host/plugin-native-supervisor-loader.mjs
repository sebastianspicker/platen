import { stageNativeHelper } from './native-helper-loader.mjs';
import { PluginNativeSupervisor } from './plugin-native-supervisor.mjs';
import { validateNativeReleasePolicy } from './plugin-native-supervisor-contract.mjs';

const SUPERVISOR_CANDIDATES = Object.freeze([Object.freeze({
  kind: 'packaged-release',
  relativePath: 'Contents/Helpers/PDFPluginSupervisor',
})]);
const WORKER_CANDIDATES = Object.freeze([Object.freeze({
  kind: 'packaged-release',
  relativePath: 'Contents/Helpers/PDFPluginWorker',
})]);

function unavailable(reason) {
  return Object.freeze({ available: false, reason });
}

/**
 * Stages only the signed app-bundle helper pair. SwiftPM debug/release output
 * is intentionally not a candidate and can never become an execution fallback.
 */
export async function stagePackagedPluginNativeSupervisor({
  applicationRoot,
  sessionRoot,
  policy,
  platform = process.platform,
  stage = stageNativeHelper,
  supervisorOptions = {},
} = {}) {
  if (typeof stage !== 'function' || !supervisorOptions
    || typeof supervisorOptions !== 'object' || Array.isArray(supervisorOptions)) {
    throw new TypeError('Native supervisor loader dependencies are invalid.');
  }
  const checkedPolicy = validateNativeReleasePolicy(policy);
  const supervisor = await stage({
    root: applicationRoot,
    sessionRoot,
    candidates: SUPERVISOR_CANDIDATES,
    destinationName: 'PDFPluginSupervisor',
    label: 'plugin supervisor',
    platform,
  });
  if (!supervisor.available) return unavailable(supervisor.reason);
  const worker = await stage({
    root: applicationRoot,
    sessionRoot,
    candidates: WORKER_CANDIDATES,
    destinationName: 'PDFPluginWorker',
    label: 'plugin worker',
    platform,
  });
  if (!worker.available) return unavailable(worker.reason);
  const stagedSupervisor = Object.freeze({
    executable: supervisor.executable,
    sha256: supervisor.sha256,
  });
  const stagedWorker = Object.freeze({ executable: worker.executable, sha256: worker.sha256 });
  return Object.freeze({
    available: true,
    supervisor: new PluginNativeSupervisor({
      ...supervisorOptions,
      supervisor: stagedSupervisor,
      worker: stagedWorker,
      policy: checkedPolicy,
    }),
    artifacts: Object.freeze({ supervisor: stagedSupervisor, worker: stagedWorker }),
  });
}

export const PACKAGED_PLUGIN_NATIVE_CANDIDATES = Object.freeze({
  supervisor: SUPERVISOR_CANDIDATES,
  worker: WORKER_CANDIDATES,
});
