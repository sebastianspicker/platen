import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalHost } from './local-host.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const host = '127.0.0.1';
const configuredPort = Number.parseInt(process.env.PLATEN_PORT ?? '4173', 10);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536 ? configuredPort : 4173;
let application;
try {
  application = await startLocalHost({ root, host, port });
  console.log(`Platen available at http://${host}:${port}`);
} catch (error) {
  console.error(`Platen server failed: ${error.message}`);
  process.exitCode = 1;
}

async function shutdown() {
  if (!application) return;
  await new Promise((resolveClose) => application.server.close(resolveClose));
  await (application.close?.() ?? application.store.dispose());
  application = null;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown().finally(() => process.exit());
  });
}
