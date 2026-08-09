import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../scripts/host/host-error.mjs';
import { AUTOMATION_INSPECT_TYPE } from '../scripts/host/automation/automation-operation-contract.mjs';
import { runCli } from '../scripts/platen-cli.mjs';
import {
  AUTOMATION_SUBMIT_CLI_GRANT, AUTOMATION_SUBMIT_CLI_PRINCIPAL,
  createAutomationSubmitCliAuthority,
} from '../scripts/cli/automation-submit-authority.mjs';

const source = Object.freeze({ id: 'source_1', sha256: 'a'.repeat(64) });
const command = Object.freeze({ command: 'automation-submit-inspect', input: 'input.pdf',
  automationRoot: 'private', idempotencyKey: null, output: null });

function context(overrides = {}) {
  return Object.freeze({ principal: AUTOMATION_SUBMIT_CLI_PRINCIPAL, capability: 'automation.submit',
    action: 'submit', operation: Object.freeze({ kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null }),
    source, idempotencyKey: 'request-1', jobId: null, outputId: null, ...overrides });
}

function denied(promise) {
  return assert.rejects(promise, (error) => error instanceof HostError
    && error.code === 'AUTOMATION_SUBMIT_CLI_AUTHORITY_DENIED' && error.status === 403);
}

test('submit CLI authority permits exactly one source-bound parsed selection', async () => {
  const authority = createAutomationSubmitCliAuthority(command);
  await authority.authorize(AUTOMATION_SUBMIT_CLI_GRANT, context());
  await authority.authorize(AUTOMATION_SUBMIT_CLI_GRANT, context());
  await denied(authority.authorize(AUTOMATION_SUBMIT_CLI_GRANT,
    context({ source: { ...source, id: 'other_source' } })));
  await denied(authority.authorize(AUTOMATION_SUBMIT_CLI_GRANT, context({ idempotencyKey: 'other-request' })));
});

test('submit CLI authority rejects drift, other capabilities, extra fields, proxies, and accessors', async () => {
  const authority = createAutomationSubmitCliAuthority(command);
  await denied(authority.authorize({ ...AUTOMATION_SUBMIT_CLI_GRANT, grantId: 'other-grant' }, context()));
  await denied(authority.authorize(AUTOMATION_SUBMIT_CLI_GRANT,
    context({ operation: { kind: 'operation', id: 'automation_ocr_v1', pages: null } })));
  await denied(authority.authorize(AUTOMATION_SUBMIT_CLI_GRANT,
    context({ capability: 'automation.status', action: 'status' })));
  await denied(authority.authorize(AUTOMATION_SUBMIT_CLI_GRANT, { ...context(), extra: true }));
  const proxy = new Proxy(AUTOMATION_SUBMIT_CLI_GRANT, { get() { throw new Error('trap'); } });
  await denied(authority.authorize(proxy, context()));
  let accessed = false;
  const accessor = {};
  Object.defineProperty(accessor, 'id', { enumerable: true, get() { accessed = true; return source.id; } });
  Object.defineProperty(accessor, 'sha256', { enumerable: true, value: source.sha256 });
  await denied(authority.authorize(AUTOMATION_SUBMIT_CLI_GRANT, context({ source: accessor })));
  assert.equal(accessed, false);
});

test('submit authority is absent for other and custom-OCR commands, and CLI injection excludes batch', async () => {
  assert.equal(createAutomationSubmitCliAuthority({ command: 'engines' }), null);
  assert.equal(createAutomationSubmitCliAuthority({ command: 'automation-submit-ocr', input: 'input.pdf',
    automationRoot: 'private', idempotencyKey: null, output: null, language: 'deu',
    cleanupPreset: 'document', segmentation: 'auto' }), null);
  const options = []; const application = { automation: {}, close: async () => {}, service: { async availability() { return []; } } };
  await assert.rejects(runCli(['automation-submit-inspect', 'input.pdf', '--automation-root', 'private'], {
    createApplication: async (value) => { options.push(value); return application; },
  }));
  await assert.rejects(runCli(['automation-submit-batch', 'one.pdf', 'two.pdf', '--automation-root', 'private',
    '--idempotency-key', 'batch-key', '--operation', 'inspect'], {
    createApplication: async (value) => { options.push(value); return application; },
  }));
  assert.equal(typeof options[0].automationCapabilityAuthority?.authorize, 'function');
  assert.equal(Object.hasOwn(options[1], 'automationCapabilityAuthority'), false);
});
