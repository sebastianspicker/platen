import { types as nodeTypes } from 'node:util';
import { HostError } from '../host/host-error.mjs';
import {
  AUTOMATION_INSPECT_PRESET,
  AUTOMATION_OCR_PRESET,
  AUTOMATION_OUTPUT_INTENT_PRESET,
  OPAQUE_ID,
  SHA256,
} from '../host/automation/automation-operation-contract.mjs';

/** The sole principal used by the invocation-scoped recipe CLI capability. */
export const AUTOMATION_RECIPE_CLI_PRINCIPAL = 'platen.cli.automation-recipe';

/** The sole grant accepted by the invocation-scoped recipe CLI capability. */
export const AUTOMATION_RECIPE_CLI_GRANT = Object.freeze({
  grantId: 'platen-cli-automation-recipe-v1',
  principal: AUTOMATION_RECIPE_CLI_PRINCIPAL,
});

const AUTHORITY_CODE = 'AUTOMATION_RECIPE_CLI_AUTHORITY_DENIED';
const RECIPE_PRESETS = Object.freeze({
  'inspect-document-v1': AUTOMATION_INSPECT_PRESET,
  'ocr-english-document-v1': AUTOMATION_OCR_PRESET,
  'assign-cmyk-output-intent-v1': AUTOMATION_OUTPUT_INTENT_PRESET,
});
const RECIPE_IDS = new Set(Object.keys(RECIPE_PRESETS));

function deny() {
  throw new HostError(
    AUTHORITY_CODE,
    'The automation recipe CLI capability does not authorize this request.',
    403,
  );
}

/*
 * Read only descriptor-backed records.  The proxy check occurs before any
 * operation which could invoke a proxy trap; descriptor values are used so
 * accessors are rejected without invoking them.
 */
function dataRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || nodeTypes.isProxy(value)) return null;
  let descriptors;
  let ownKeys;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (ownKeys.length !== keys.length || ownKeys.some((key) => (
    typeof key !== 'string' || !keys.includes(key)
      || !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value')
      || descriptors[key].enumerable !== true
  ))) return null;
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function sourceBinding(value) {
  const source = dataRecord(value, ['id', 'sha256']);
  if (!source || !OPAQUE_ID.test(source.id ?? '') || !SHA256.test(source.sha256 ?? '')) return null;
  return source;
}

function recipeSelection(value, commandRecipe, commandRepeat) {
  const recipe = dataRecord(value, ['id', 'repeat', 'version']);
  if (!recipe || recipe.id !== commandRecipe || recipe.version !== 1
    || recipe.repeat !== commandRepeat) return null;
  return recipe;
}

function operationSelection(value, expectedPreset) {
  const operation = dataRecord(value, ['id', 'kind', 'pages']);
  if (!operation || operation.kind !== 'preset' || operation.id !== expectedPreset || operation.pages !== null) return null;
  return operation;
}

function commandBinding(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)
    || nodeTypes.isProxy(command)) deny();
  let descriptors;
  try {
    if (Object.getPrototypeOf(command) !== Object.prototype) deny();
    descriptors = Object.getOwnPropertyDescriptors(command);
  } catch {
    deny();
  }
  const commandName = descriptors?.command;
  if (!commandName || !Object.hasOwn(commandName, 'value') || commandName.enumerable !== true
    || commandName.value !== 'automation-run-recipe') return null;
  const recipe = descriptors?.recipe;
  const repeat = descriptors?.repeat;
  if (!recipe || !Object.hasOwn(recipe, 'value') || recipe.enumerable !== true
    || !repeat || !Object.hasOwn(repeat, 'value') || repeat.enumerable !== true
    || typeof recipe.value !== 'string' || !RECIPE_IDS.has(recipe.value)
    || !Number.isSafeInteger(repeat.value) || repeat.value < 1 || repeat.value > 4) deny();
  return Object.freeze({ recipe: recipe.value, repeat: repeat.value, preset: RECIPE_PRESETS[recipe.value] });
}

/**
 * Create the authority used by one `automation-run-recipe` invocation.
 * No caller-supplied principal or grant is accepted; both are fixed above.
 */
export function createAutomationRecipeCliAuthority(command) {
  const binding = commandBinding(command);
  if (binding === null) return null;
  return Object.freeze({
    async authorize(grant, context) {
      const candidateGrant = dataRecord(grant, ['grantId', 'principal']);
      if (!candidateGrant
        || candidateGrant.grantId !== AUTOMATION_RECIPE_CLI_GRANT.grantId
        || candidateGrant.principal !== AUTOMATION_RECIPE_CLI_PRINCIPAL) deny();

      if (!context || typeof context !== 'object' || Array.isArray(context) || nodeTypes.isProxy(context)) deny();
      let common;
      try {
        if (Object.getPrototypeOf(context) !== Object.prototype) deny();
        const capability = Object.getOwnPropertyDescriptor(context, 'capability');
        if (!capability || !Object.hasOwn(capability, 'value') || capability.enumerable !== true) deny();
        if (capability.value === 'automation.javascript') {
          common = dataRecord(context, ['action', 'capability', 'executionId', 'operation', 'principal', 'recipe', 'source']);
        } else if (capability.value === 'automation.submit' || capability.value === 'automation.cancel') {
          common = dataRecord(context, ['action', 'capability', 'jobId', 'operation', 'outputId', 'principal', 'source']);
        } else deny();
      } catch {
        deny();
      }
      if (!common || common.principal !== AUTOMATION_RECIPE_CLI_PRINCIPAL) deny();

      if (common.capability === 'automation.javascript') {
        if (!['automation-js.execute', 'automation-js.submit', 'automation-js.cancel',
          'automation-js.release'].includes(common.action)) deny();
        const recipe = recipeSelection(common.recipe, binding.recipe, binding.repeat);
        const source = sourceBinding(common.source);
        if (!OPAQUE_ID.test(common.executionId ?? '')) deny();
        if (common.action === 'automation-js.submit') {
          if (!recipe || !source || !operationSelection(common.operation, binding.preset)) deny();
          return true;
        }
        if (common.action === 'automation-js.execute') {
          if (!recipe || !source || common.operation !== null) deny();
          return true;
        }
        if (!['automation-js.cancel', 'automation-js.release'].includes(common.action)
          || common.operation !== null || !recipe || !source) deny();
        return true;
      }

      if (common.capability === 'automation.submit') {
        if (common.action !== 'submit' || common.jobId !== null || common.outputId !== null
          || !sourceBinding(common.source)
          || !operationSelection(common.operation, binding.preset)) deny();
        return true;
      }

      if (common.capability === 'automation.cancel') {
        if (common.action !== 'cancel' || common.source !== null || common.operation !== null
          || common.outputId !== null || !OPAQUE_ID.test(common.jobId ?? '')) deny();
        return true;
      }

      deny();
    },
  });
}
