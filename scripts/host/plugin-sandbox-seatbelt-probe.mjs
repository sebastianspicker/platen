import { join } from 'node:path';
import {
  DARWIN_SANDBOX_EXEC,
  buildDarwinPluginProbeProfile,
  darwinProbeEnvironment,
  darwinSeatbeltProbeSource,
  parseDarwinSeatbeltProbeOutput,
  unavailableDarwinPluginSandbox,
} from './plugin-sandbox-darwin-contract.mjs';

export async function runDarwinSeatbeltProbe({
  runner,
  resolvedNode,
  workspace,
  sentinelPath,
  signal,
  platform,
}) {
  let processResult;
  try {
    processResult = await runner({
      executable: DARWIN_SANDBOX_EXEC,
      args: [
        '-p',
        buildDarwinPluginProbeProfile(),
        resolvedNode,
        '--jitless',
        '-e',
        darwinSeatbeltProbeSource(sentinelPath, join(workspace, 'forbidden-write.txt')),
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
        `The macOS sandbox behavior probe failed: ${code}.`,
        platform,
      ),
    };
  }
  return { evidence: parseDarwinSeatbeltProbeOutput(processResult.stdout) };
}
