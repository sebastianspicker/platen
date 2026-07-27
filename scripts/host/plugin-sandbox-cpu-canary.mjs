import { darwinProbeEnvironment } from './plugin-sandbox-darwin-contract.mjs';

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
      timeoutMs: 4_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      environment: darwinProbeEnvironment(workspace),
    });
    return false;
  } catch (error) {
    return error?.signal === 'SIGXCPU' || error?.exitCode === 152;
  }
}
