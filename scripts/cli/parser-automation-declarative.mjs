import {
  boundedPath,
  exactPositionals,
  fail,
  positiveInteger,
} from './parser-foundation.mjs';
import { AUTOMATION_JS_MAX_REPEATS } from '../host/automation/automation-js-contract.mjs';
import { AUTOMATION_JS_RECIPE_IDS } from '../host/automation/automation-js-registry.mjs';
import { AUTOMATION_CONDITIONAL_MAX_IDEMPOTENCY_BYTES } from '../host/automation/automation-conditional-workflow-contract.mjs';

function automationRoot(values) {
  if (!values.has('automation-root')) fail('CLI_INVALID_OPTION', 'Automation commands require --automation-root.');
  return boundedPath(values.get('automation-root'), 'Automation root');
}

function automationRecipeIdempotencyKey(value) {
  if (value === undefined) return null;
  if (!value || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001F\u007F]/u.test(value)) {
    fail('CLI_INVALID_OPTION', '--idempotency-key must be a non-empty value no longer than 256 UTF-8 bytes without ASCII controls.');
  }
  return value;
}

function automationConditionalIdempotencyKey(value) {
  if (value === undefined) return null;
  if (!value || Buffer.byteLength(value, 'utf8') > AUTOMATION_CONDITIONAL_MAX_IDEMPOTENCY_BYTES
    || /[\u0000-\u001F\u007F]/u.test(value)) {
    fail('CLI_INVALID_OPTION', `--idempotency-key must be a non-empty value no longer than ${AUTOMATION_CONDITIONAL_MAX_IDEMPOTENCY_BYTES} UTF-8 bytes without ASCII controls.`);
  }
  return value;
}

export function parseAutomationDeclarative(command, positionals, values, output) {
  if (!['automation-run-conditional', 'automation-run-recipe', 'automation-watch-discover'].includes(command)) return null;
  const root = automationRoot(values);
  if (command === 'automation-run-conditional') {
    const [input] = exactPositionals(positionals, 1);
    if (!/\.pdf$/iu.test(input)) fail('CLI_INVALID_OPTION', 'automation-run-conditional accepts one .pdf input.');
    if (!values.has('workflow')) fail('CLI_INVALID_OPTION', 'The automation-run-conditional command requires --workflow.');
    return Object.freeze({
      command,
      input,
      automationRoot: root,
      workflow: boundedPath(values.get('workflow'), 'Workflow'),
      idempotencyKey: automationConditionalIdempotencyKey(values.get('idempotency-key')),
      output,
    });
  }
  if (command === 'automation-run-recipe') {
    const [input] = exactPositionals(positionals, 1);
    const recipe = values.get('recipe') ?? null;
    if (!AUTOMATION_JS_RECIPE_IDS.includes(recipe)) fail('CLI_INVALID_OPTION', '--recipe must be an allowlisted declarative automation recipe.');
    return Object.freeze({
      command,
      input,
      automationRoot: root,
      recipe,
      repeat: values.has('repeat') ? positiveInteger(values.get('repeat'), '--repeat', AUTOMATION_JS_MAX_REPEATS) : 1,
      idempotencyKey: automationRecipeIdempotencyKey(values.get('idempotency-key')),
      output,
    });
  }
  const [input] = exactPositionals(positionals, 1);
  return Object.freeze({ command, input: boundedPath(input, 'Watch directory'), automationRoot: root, output });
}
