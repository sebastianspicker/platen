import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTOMATION_INSPECT_PRESET } from '../scripts/host/automation/automation-operation-contract.mjs';
import { HostError } from '../scripts/host/host-error.mjs';
import { runCli } from '../scripts/platen-cli.mjs';
import {
  AUTOMATION_RECIPE_CLI_GRANT,
  AUTOMATION_RECIPE_CLI_PRINCIPAL,
  createAutomationRecipeCliAuthority,
} from '../scripts/cli/automation-recipe-authority.mjs';

const source = Object.freeze({ id: 'source_1', sha256: 'a'.repeat(64) });
const recipe = Object.freeze({ id: 'inspect-document-v1', version: 1, repeat: 2 });
const operation = Object.freeze({ kind: 'preset', id: AUTOMATION_INSPECT_PRESET, pages: null });

function javascriptContext(action, overrides = {}) {
  return Object.freeze({
    principal: AUTOMATION_RECIPE_CLI_PRINCIPAL,
    capability: 'automation.javascript',
    action,
    executionId: 'ajs_12345678901234567890123456789012',
    source,
    recipe,
    operation: action === 'automation-js.submit' ? operation : null,
    ...overrides,
  });
}

function apiContext(capability, action, overrides = {}) {
  return Object.freeze({
    principal: AUTOMATION_RECIPE_CLI_PRINCIPAL,
    capability,
    action,
    source,
    operation,
    jobId: null,
    outputId: null,
    ...overrides,
  });
}

function denied(promise) {
  return assert.rejects(promise, (error) => (
    error instanceof HostError
      && error.code === 'AUTOMATION_RECIPE_CLI_AUTHORITY_DENIED'
      && error.status === 403
  ));
}

test('recipe CLI authority allows only the selected recipe and fixed operation', async () => {
  const authority = createAutomationRecipeCliAuthority({ command: 'automation-run-recipe', recipe: recipe.id, repeat: recipe.repeat });
  await authority.authorize(AUTOMATION_RECIPE_CLI_GRANT, javascriptContext('automation-js.execute', { operation: null }));
  await authority.authorize(AUTOMATION_RECIPE_CLI_GRANT, javascriptContext('automation-js.submit'));
  await authority.authorize(AUTOMATION_RECIPE_CLI_GRANT, javascriptContext('automation-js.cancel', { operation: null }));
  await authority.authorize(AUTOMATION_RECIPE_CLI_GRANT, javascriptContext('automation-js.release', { operation: null }));
  await authority.authorize(AUTOMATION_RECIPE_CLI_GRANT, apiContext('automation.submit', 'submit'));
  await authority.authorize(AUTOMATION_RECIPE_CLI_GRANT, apiContext('automation.cancel', 'cancel', {
    source: null, operation: null, jobId: 'job_1',
  }));
});

test('recipe CLI authority rejects grant, recipe, operation, and binding drift', async () => {
  const authority = createAutomationRecipeCliAuthority({ command: 'automation-run-recipe', recipe: recipe.id, repeat: recipe.repeat });
  await denied(authority.authorize({ ...AUTOMATION_RECIPE_CLI_GRANT, grantId: 'other-grant-v1' }, javascriptContext('automation-js.execute')));
  await denied(authority.authorize(AUTOMATION_RECIPE_CLI_GRANT, javascriptContext('automation-js.execute', {
    recipe: { ...recipe, id: 'ocr-english-document-v1' },
  })));
  await denied(authority.authorize(AUTOMATION_RECIPE_CLI_GRANT, javascriptContext('automation-js.submit', {
    operation: { ...operation, id: 'ocr-english-document-v1' },
  })));
  await denied(authority.authorize(AUTOMATION_RECIPE_CLI_GRANT, apiContext('automation.cancel', 'cancel', {
    source: null, operation: null, jobId: 'not valid!',
  })));
});

test('recipe CLI authority rejects proxies and accessors without invoking them', async () => {
  const authority = createAutomationRecipeCliAuthority({ command: 'automation-run-recipe', recipe: recipe.id, repeat: recipe.repeat });
  const proxy = new Proxy(AUTOMATION_RECIPE_CLI_GRANT, { get() { throw new Error('proxy trap'); } });
  await denied(authority.authorize(proxy, javascriptContext('automation-js.execute')));
  let accessed = false;
  const accessor = {};
  Object.defineProperty(accessor, 'grantId', { enumerable: true, get() { accessed = true; return AUTOMATION_RECIPE_CLI_GRANT.grantId; } });
  Object.defineProperty(accessor, 'principal', { enumerable: true, value: AUTOMATION_RECIPE_CLI_PRINCIPAL });
  await denied(authority.authorize(accessor, javascriptContext('automation-js.execute')));
  assert.equal(accessed, false);
  assert.equal(createAutomationRecipeCliAuthority({ command: 'engines' }), null);
});

test('runCli injects the recipe authority only for automation-run-recipe', async () => {
  const options = [];
  const application = {
    automation: {},
    close: async () => {},
    service: { async availability() { return []; } },
  };
  await assert.rejects(runCli([
    'automation-run-recipe', 'input.pdf', '--recipe', recipe.id, '--automation-root', 'private',
  ], {
    createApplication: async (value) => { options.push(value); return application; },
  }));
  assert.equal(typeof options[0].automationCapabilityAuthority?.authorize, 'function');
  await runCli(['engines'], {
    createApplication: async (value) => { options.push(value); return application; },
  });
  assert.equal(Object.hasOwn(options[1], 'automationCapabilityAuthority'), false);
});
