import assert from 'node:assert/strict';
import test from 'node:test';
import { getProfessionalHandler } from '../scripts/host/professional-capability/index.mjs';
import {
  AUTOMATION_INSPECT_PRESET,
  AUTOMATION_OCR_PRESET,
  AUTOMATION_OUTPUT_INTENT_PRESET,
  AUTOMATION_PRESET_IDS,
  automationPresetDescriptor,
  presetPayload,
} from '../scripts/host/automation/automation-operation-contract.mjs';

const variablesPresets = getProfessionalHandler('automation.variables-presets');

function assertDeepFrozen(value, path = 'value', seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${path} must be frozen`);
  for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, `${path}.${key}`, seen);
}

test('variables-presets exposes exactly the fixed immutable versioned registry', async () => {
  const expected = {
    kind: 'professional-capability-result',
    schemaVersion: 1,
    capabilityId: 'automation.variables-presets',
    ok: true,
    localOnly: true,
    method: 'local-automation-allowlisted-presets',
    count: 3,
    typed: true,
    immutable: true,
    presets: [
      {
        name: AUTOMATION_INSPECT_PRESET,
        version: 1,
        operation: 'automation_inspect_v1',
        variables: {},
        presetId: '2617dbe168a73013',
      },
      {
        name: AUTOMATION_OCR_PRESET,
        version: 1,
        operation: 'automation_ocr_v1',
        variables: {
          language: { type: 'string', default: 'eng' },
          cleanupPreset: { type: 'string', default: 'document' },
          segmentation: { type: 'string', default: 'auto' },
          userDictionary: { type: 'array', default: [] },
        },
        presetId: '01979ba84f006221',
      },
      {
        name: AUTOMATION_OUTPUT_INTENT_PRESET,
        version: 1,
        operation: 'automation_output_intent_v1',
        variables: {
          profile: { type: 'string', default: 'local-ghostscript-default-cmyk-output-intent-v1' },
        },
        presetId: '48f162ff518a60f8',
      },
    ],
    limitations: [
      'Only three host-defined preset descriptors are listed; user-defined presets, arbitrary variables, code or expression evaluation, and durable execution are not exposed.',
    ],
  };

  const first = await variablesPresets({});
  const second = await variablesPresets({});
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assertDeepFrozen(first);
  assert.deepEqual(first, second, 'repeated calls must be deterministic');
  assert.deepEqual(AUTOMATION_PRESET_IDS, [
    AUTOMATION_INSPECT_PRESET,
    AUTOMATION_OCR_PRESET,
    AUTOMATION_OUTPUT_INTENT_PRESET,
  ].sort());
  assert.equal(Object.isFrozen(AUTOMATION_PRESET_IDS), true);
});

test('single preset selection is exact and cannot mutate the shipped registry', async () => {
  const outcome = await variablesPresets({ preset: AUTOMATION_OCR_PRESET });
  assert.equal(outcome.count, 1);
  assert.deepEqual(outcome.presets[0], {
    name: AUTOMATION_OCR_PRESET,
    version: 1,
    operation: 'automation_ocr_v1',
    variables: {
      language: { type: 'string', default: 'eng' },
      cleanupPreset: { type: 'string', default: 'document' },
      segmentation: { type: 'string', default: 'auto' },
      userDictionary: { type: 'array', default: [] },
    },
    presetId: '01979ba84f006221',
  });
  assertDeepFrozen(outcome);
  assert.throws(() => { outcome.presets[0].variables.language.default = 'fra'; }, TypeError);
  assert.throws(() => { outcome.presets.push({}); }, TypeError);
  assert.equal(automationPresetDescriptor(AUTOMATION_OCR_PRESET).fields.language, 'eng');
  assert.equal(automationPresetDescriptor(AUTOMATION_OCR_PRESET).fields.userDictionary.length, 0);
});

test('unknown, accessor, proxy, polluted, and dynamic registration inputs fail closed', async () => {
  await assert.rejects(() => variablesPresets({ preset: 'caller-defined-preset' }), {
    code: 'INVALID_AUTOMATION_OPERATION',
  });

  const source = {
    preset: AUTOMATION_INSPECT_PRESET,
    sourceId: 'source_1',
    sha256: 'a'.repeat(64),
  };
  const accessor = { ...source };
  Object.defineProperty(accessor, 'preset', {
    enumerable: true,
    get: () => AUTOMATION_INSPECT_PRESET,
  });
  assert.throws(() => presetPayload(accessor), { code: 'INVALID_AUTOMATION_OPERATION' });

  const polluted = Object.create({ polluted: true });
  Object.assign(polluted, source);
  assert.throws(() => presetPayload(polluted), { code: 'INVALID_AUTOMATION_OPERATION' });

  const proxied = new Proxy(source, { ownKeys() { throw new Error('proxy trap'); } });
  assert.throws(() => presetPayload(proxied), { code: 'INVALID_AUTOMATION_OPERATION' });

  const withDynamicFields = await variablesPresets({
    preset: AUTOMATION_INSPECT_PRESET,
    code: 'return process',
    expression: 'userInput + 1',
    register: () => {},
    script: 'arbitrary code',
    variables: { userInput: 1 },
  });
  const fixed = await variablesPresets({ preset: AUTOMATION_INSPECT_PRESET });
  assert.deepEqual(withDynamicFields, fixed, 'dynamic fields must not alter the fixed registry result');
  assert.equal(Object.hasOwn(withDynamicFields, 'code'), false);
  assert.equal(Object.hasOwn(withDynamicFields, 'expression'), false);
  assert.equal(Object.hasOwn(withDynamicFields, 'register'), false);
  assert.equal(Object.hasOwn(withDynamicFields, 'script'), false);
});
