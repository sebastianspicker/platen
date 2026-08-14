import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startLocalHost } from '../scripts/local-host.mjs';

test('listener startup failure closes the server and disposes the private store', async () => {
  const failure = new Error('listen blocked');
  let disposed = false;
  let closed = false;
  class FailingServer extends EventEmitter {
    listen() { queueMicrotask(() => this.emit('error', failure)); }
    close(callback) { closed = true; callback?.(); }
  }
  const server = new FailingServer();
  const application = {
    handler: async () => {},
    store: { dispose: async () => { disposed = true; } },
    service: {}, token: 'token', host: '127.0.0.1', port: 4173,
  };

  await assert.rejects(
    startLocalHost({}, {
      createApplication: async () => application,
      createServerImpl: () => server,
    }),
    failure,
  );
  assert.equal(closed, true);
  assert.equal(disposed, true);
});

test('listener startup failure preserves application close failures', async () => {
  const listenFailure = new Error('listen blocked');
  const closeFailure = new Error('application close blocked');
  class FailingServer extends EventEmitter {
    listen() { queueMicrotask(() => this.emit('error', listenFailure)); }
    close(callback) { callback?.(); }
  }
  const application = {
    handler: async () => {}, close: async () => { throw closeFailure; },
    store: { dispose: async () => {} }, service: {}, token: 'token', host: '127.0.0.1', port: 4173,
  };

  await assert.rejects(
    startLocalHost({}, {
      createApplication: async () => application,
      createServerImpl: () => new FailingServer(),
    }),
    (error) => error instanceof AggregateError
      && error.errors.includes(listenFailure) && error.errors.includes(closeFailure),
  );
});
