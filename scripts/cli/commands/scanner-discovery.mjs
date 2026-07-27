export async function runScannerDiscoveryCommand(application, command, stdout, signal, runtime) {
  runtime.cancelled(signal);
  const result = await application.scannerDiscovery.discover({ signal });
  runtime.cancelled(signal);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (command.output) await runtime.writeExclusive(command.output, output, signal);
  else await runtime.emit(stdout, output);
  await runtime.emit(stdout, { kind: 'scanner-discovery', output: command.output, deviceCount: result.ok ? result.result.devices.length : 0, discoveryOnly: true, localOnly: true });
}
