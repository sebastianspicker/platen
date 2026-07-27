import {
  darwinNodePermissionProbeSource,
  darwinProbeEnvironment,
  parseDarwinNodePermissionProbeOutput,
  unavailableDarwinPluginSandbox,
} from './plugin-sandbox-darwin-contract.mjs';

export async function runDarwinNodePermissionProbe({
  runner,
  resolvedNode,
  workspace,
  signal,
  platform,
}) {
  let processResult;
  try {
    processResult = await runner({
      executable: resolvedNode,
      args: [
        '--permission',
        '--input-type=module',
        '--eval',
        darwinNodePermissionProbeSource(),
      ],
      cwd: workspace,
      signal,
      timeoutMs: 5_000,
      maxStdoutBytes: 8 * 1024,
      maxStderrBytes: 8 * 1024,
      environment: darwinProbeEnvironment(workspace),
    });
  } catch (error) {
    const code = String(error?.code ?? 'PROCESS_FAILED').slice(0, 80);
    return {
      failure: unavailableDarwinPluginSandbox(
        `The Node permission behavior probe failed: ${code}.`,
        platform,
      ),
    };
  }
  return { evidence: parseDarwinNodePermissionProbeOutput(processResult.stdout) };
}
