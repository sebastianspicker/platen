import { createServer } from 'node:http';
import { createLocalApplication } from './bootstrap/local-application.mjs';

export { createLocalApplication };

export async function startLocalHost(options, {
  createApplication = createLocalApplication,
  createServerImpl = createServer,
} = {}) {
  const application = await createApplication(options);
  const server = createServerImpl((request, response) => {
    application.handler(request, response).catch((error) => {
      console.error(`Platen request failed: ${error.message}`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(application.port, application.host, resolve);
    });
  } catch (error) {
    const failures = [error];
    try {
      await new Promise((resolveClose, rejectClose) => {
        try { server.close((closeError) => (closeError ? rejectClose(closeError) : resolveClose())); } catch (closeError) { rejectClose(closeError); }
      });
    } catch (cleanupError) { failures.push(cleanupError); }
    try {
      await (application.close?.() ?? application.store.dispose());
    } catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Local host startup and cleanup failed.');
    }
    throw error;
  }
  return Object.freeze({ ...application, server });
}
