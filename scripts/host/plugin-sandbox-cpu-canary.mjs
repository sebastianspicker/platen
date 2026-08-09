import { darwinProbeEnvironment } from './plugin-sandbox-darwin-contract.mjs';

const CPU_CANARY_TIMEOUT_MS = 15_000;

export async function runDarwinCpuLimitCanary({
  runner,
  resolvedNode,
  workspace,
  signal,
}) {
  try {
    await runner({
      executable: '/bin/sh',
      args: [
        '-c',
        'ulimit -t 1 || exit 90; exec "$1" --input-type=module --eval "while (true) {}"',
        'plugin-cpu-probe',
        resolvedNode,
      ],
      cwd: workspace,
      signal,
      timeoutMs: CPU_CANARY_TIMEOUT_MS,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      environment: darwinProbeEnvironment(workspace),
    });
    return false;
  } catch (error) {
    return error?.signal === 'SIGXCPU' || error?.exitCode === 152;
  }
}
