import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageRoot = join(root, 'native/plugin-worker');

function swiftSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return swiftSources(path);
    return entry.name.endsWith('.swift') ? [path] : [];
  });
}

test('native plugin runtime remains split into bounded responsibility files', () => {
  const files = swiftSources(join(packageRoot, 'Sources'));
  assert.deepEqual(files.map((path) => relative(packageRoot, path)).sort(), [
    'Sources/PDFPluginSupervisor/ProcessLifecycle.swift',
    'Sources/PDFPluginSupervisor/main.swift',
    'Sources/PDFPluginWorker/main.swift',
    'Sources/PluginWorkerCore/Bootstrap.swift',
    'Sources/PluginWorkerCore/DescriptorIO.swift',
    'Sources/PluginWorkerCore/DocumentRPC.swift',
    'Sources/PluginWorkerCore/Frames.swift',
    'Sources/PluginWorkerCore/JSONValue.swift',
    'Sources/PluginWorkerCore/JavaScriptPlugin.swift',
    'Sources/PluginWorkerCore/PluginWorkerError.swift',
    'Sources/PluginWorkerCore/ResourceLimits.swift',
    'Sources/PluginWorkerCore/ScriptPolicy.swift',
    'Sources/PluginWorkerCore/SigningValidation.swift',
  ]);
  for (const path of files) {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/u).length;
    assert.ok(lines <= 400, `${relative(packageRoot, path)} exceeded 400 lines`);
  }
});

test('supervisor proves private pipes before ready and owns worker reap cleanup', () => {
  const main = readFileSync(join(packageRoot, 'Sources/PDFPluginSupervisor/main.swift'), 'utf8');
  assert.ok(main.indexOf('fcntl(3, F_GETFD)') < main.indexOf('readyAttestation('));
  assert.match(main, /defer \{ if !workerFinished \{ terminateAndReap\(process\) \} \}/u);
  const lifecycle = readFileSync(join(packageRoot, 'Sources/PDFPluginSupervisor/ProcessLifecycle.swift'), 'utf8');
  assert.match(lifecycle, /process[.]terminate\(\)/u);
  assert.match(lifecycle, /SIGKILL/u);
  assert.match(lifecycle, /process[.]waitUntilExit\(\)/u);
});

test('native signing and RPC contracts retain the minimal authority surface', () => {
  const signing = readFileSync(join(packageRoot, 'Sources/PluginWorkerCore/SigningValidation.swift'), 'utf8');
  assert.match(signing, /kSecCSStrictValidate \| kSecCSCheckAllArchitectures/u);
  assert.match(signing, /Set\(values[.]keys\) == \["com[.]apple[.]security[.]app-sandbox"\]/u);
  assert.doesNotMatch(signing, /keychain-access-groups|network[.]client|temporary-exception/u);
  const rpc = readFileSync(join(packageRoot, 'Sources/PluginWorkerCore/DocumentRPC.swift'), 'utf8');
  assert.match(rpc, /options: \[[.]sortedKeys\]/u);
  assert.match(rpc, /method == "document[.]getMetadata" \|\| method == "document[.]readRange"/u);
});
