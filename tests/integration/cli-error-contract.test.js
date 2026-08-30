import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalOperationError } from '../../src/contracts/errors.js';
import { HostError } from '../../src/host/platform/runtime/host-error.mjs';
import { runCli } from '../../src/cli/main.mjs';

test('CLI-local operation errors retain their public status, code, and cause', () => {
  const cause = new Error('fixture cause');
  const error = new LocalOperationError('AUTOMATION_SERVICE_REQUIRED', 'Automation API status is unavailable.', 503, { cause });

  assert.equal(error.name, 'LocalOperationError');
  assert.equal(error.code, 'AUTOMATION_SERVICE_REQUIRED');
  assert.equal(error.status, 503);
  assert.equal(error.cause, cause);
});

test('HostError remains a status-bearing local operation error', () => {
  const cause = new Error('fixture cause');
  const error = new HostError('HOST_UNAVAILABLE', 'The local host is unavailable.', 503, { cause });

  assert.equal(error instanceof LocalOperationError, true);
  assert.equal(error.name, 'HostError');
  assert.equal(error.code, 'HOST_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.cause, cause);
});

test('CLI command failures preserve a neutral local-operation status', async () => {
  const expected = new LocalOperationError('AUTOMATION_SERVICE_REQUIRED', 'Automation API status is unavailable.', 503);
  await assert.rejects(
    runCli(['engines'], {
      createApplication: async () => ({
        service: { availability: async () => { throw expected; } },
        cli: { close: async () => {} },
      }),
    }),
    (error) => error === expected && error.status === 503,
  );
});
