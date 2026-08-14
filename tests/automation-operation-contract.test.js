import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE, AUTOMATION_INSPECT_PRESET,
  AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_PRESET, AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_PRESET, AUTOMATION_OUTPUT_INTENT_TYPE,
  AUTOMATION_PRESET_IDS, AUTOMATION_PRESET_SCHEMA_VERSION,
  MAX_FULL_PAGE_REDACTION_PAGE, MAX_FULL_PAGE_REDACTION_PAGES, OPAQUE_ID,
  SHA256, automationPresetDescriptor, expandAutomationPreset, fullPageRedactionPayload,
  invalidOperation, normalizedOcrOptions, ocrPayload, outputIntentPayload,
  presetPayload, sourcePayload,
} from '../scripts/host/automation/automation-operation-contract.mjs';
import { FULL_PAGE_REDACTION_PROFILE } from '../src/core/pdf-full-page-redaction-contract.js';
import { OUTPUT_INTENT_PROFILE } from '../scripts/host/prepress/output-intent-contract.mjs';

const SHA = 'a'.repeat(64);
const SOURCE = Object.freeze({ sourceId: 'source_1', sha256: SHA });
const OCR = Object.freeze({
  ...SOURCE, language: 'eng', cleanupPreset: 'document', segmentation: 'auto', userDictionary: [],
});

function invalid(call, message) {
  assert.throws(call, {
    name: 'HostError', code: 'INVALID_AUTOMATION_OPERATION', status: 400, message,
  });
}

function tracked(target, trace, label) {
  return new Proxy(target, {
    getPrototypeOf(value) { trace.push(`${label}.getPrototypeOf`); return Object.getPrototypeOf(value); },
    ownKeys(value) { trace.push(`${label}.ownKeys`); return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(value, key) {
      trace.push(`${label}.getOwnPropertyDescriptor:${String(key)}`);
      return Object.getOwnPropertyDescriptor(value, key);
    },
    get(value, key, receiver) { trace.push(`${label}.get:${String(key)}`); return Reflect.get(value, key, receiver); },
  });
}

function expectFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') assert.equal(Object.isFrozen(nested), true);
  }
}

test('public constants and valid normalization results retain their exact immutable shapes', () => {
  assert.equal(AUTOMATION_INSPECT_TYPE, 'automation_inspect_v1');
  assert.equal(AUTOMATION_OCR_TYPE, 'automation_ocr_v1');
  assert.equal(AUTOMATION_OUTPUT_INTENT_TYPE, 'automation_output_intent_v1');
  assert.equal(AUTOMATION_FULL_PAGE_REDACTION_TYPE, 'automation_full_page_redaction_v1');
  assert.equal(AUTOMATION_PRESET_SCHEMA_VERSION, 1);
  assert.equal(MAX_FULL_PAGE_REDACTION_PAGES, 100);
  assert.equal(MAX_FULL_PAGE_REDACTION_PAGE, 100);
  assert.equal(SHA256.test(SHA), true);
  assert.equal(OPAQUE_ID.test('source_1'), true);
  assert.deepEqual(AUTOMATION_PRESET_IDS, [
    AUTOMATION_INSPECT_PRESET, AUTOMATION_OCR_PRESET, AUTOMATION_OUTPUT_INTENT_PRESET,
  ].sort());
  assert.equal(Object.isFrozen(AUTOMATION_PRESET_IDS), true);

  for (const preset of AUTOMATION_PRESET_IDS) expectFrozen(automationPresetDescriptor(preset));
  const preset = presetPayload({ preset: AUTOMATION_INSPECT_PRESET, ...SOURCE });
  assert.deepEqual(preset, { preset: AUTOMATION_INSPECT_PRESET, ...SOURCE });
  expectFrozen(preset);
  const expanded = expandAutomationPreset({ preset: AUTOMATION_OCR_PRESET, ...SOURCE });
  assert.deepEqual(expanded, { ...OCR });
  expectFrozen(expanded);
  const source = sourcePayload(SOURCE);
  assert.deepEqual(source, SOURCE);
  expectFrozen(source);
  const options = normalizedOcrOptions();
  assert.deepEqual(options, { language: 'eng', cleanupPreset: 'document', segmentation: 'auto', userDictionary: [] });
  expectFrozen(options);
  const ocr = ocrPayload(OCR);
  assert.deepEqual(ocr, OCR);
  expectFrozen(ocr);
  const output = outputIntentPayload({ ...SOURCE, profile: OUTPUT_INTENT_PROFILE });
  assert.deepEqual(output, { ...SOURCE, profile: OUTPUT_INTENT_PROFILE });
  expectFrozen(output);
  const redaction = fullPageRedactionPayload({ ...SOURCE, pages: [1, 2] });
  assert.deepEqual(redaction, { ...SOURCE, pages: [1, 2], profile: FULL_PAGE_REDACTION_PROFILE });
  expectFrozen(redaction);
  const allPages = Array.from({ length: MAX_FULL_PAGE_REDACTION_PAGES }, (_, index) => index + 1);
  const maximumRedaction = fullPageRedactionPayload({ ...SOURCE, pages: allPages });
  assert.equal(maximumRedaction.pages.at(-1), MAX_FULL_PAGE_REDACTION_PAGE);
  expectFrozen(maximumRedaction);
});

test('every validation branch exposes the established HostError code, status, and message', () => {
  invalid(() => invalidOperation('exact message'), 'exact message');
  invalid(() => automationPresetDescriptor('unknown'), 'Automation preset is not allowlisted.');
  for (const value of [null, [], Object.create(null), { preset: AUTOMATION_INSPECT_PRESET, ...SOURCE, extra: true }]) {
    invalid(() => presetPayload(value), 'Automation preset payload is invalid.');
  }
  invalid(() => presetPayload({ preset: AUTOMATION_INSPECT_PRESET, sourceId: 'bad id', sha256: SHA }), 'Automation preset payload is invalid.');
  invalid(() => presetPayload({ preset: AUTOMATION_INSPECT_PRESET, sourceId: SOURCE.sourceId, sha256: 'A'.repeat(64) }), 'Automation preset payload is invalid.');
  invalid(() => presetPayload({ preset: 'unknown', ...SOURCE }), 'Automation preset is not allowlisted.');
  invalid(() => expandAutomationPreset({ preset: 'unknown', ...SOURCE }), 'Automation preset is not allowlisted.');

  for (const value of [null, [], Object.create(null), { ...SOURCE, extra: true }, { sourceId: 'bad id', sha256: SHA }, { sourceId: SOURCE.sourceId, sha256: 'A'.repeat(64) }]) {
    invalid(() => sourcePayload(value), 'Automation operation payload is invalid.');
  }
  for (const value of [null, [], Object.create(null)]) {
    invalid(() => normalizedOcrOptions(value), 'Automation OCR options are invalid.');
  }
  invalid(() => normalizedOcrOptions({ language: 'eng+eng' }), 'OCR language must name installed strict language tokens.');
  invalid(() => normalizedOcrOptions({ cleanupPreset: 'bad' }), 'OCR cleanup preset is invalid.');
  invalid(() => normalizedOcrOptions({ segmentation: 'bad' }), 'OCR segmentation is invalid.');
  invalid(() => normalizedOcrOptions({ userDictionary: [''] }), 'OCR user dictionary term is unsafe.');
  for (const value of [
    null, [], Object.create(null), { ...OCR, extra: true }, { ...OCR, sourceId: 'bad id' },
    { ...OCR, sha256: 'A'.repeat(64) }, { ...OCR, language: 1 }, { ...OCR, language: 'eng+ENG' },
  ]) invalid(() => ocrPayload(value), 'Automation OCR operation payload is invalid.');
  invalid(() => ocrPayload({ ...OCR, cleanupPreset: 'bad' }), 'OCR cleanup preset is invalid.');
  for (const value of [
    null, [], Object.create(null), { ...SOURCE, profile: OUTPUT_INTENT_PROFILE, extra: true },
    { ...SOURCE, profile: 'custom' }, { sourceId: 'bad id', sha256: SHA, profile: OUTPUT_INTENT_PROFILE },
    { ...SOURCE, sha256: 'A'.repeat(64), profile: OUTPUT_INTENT_PROFILE },
  ]) invalid(() => outputIntentPayload(value), 'Automation OutputIntent operation payload is invalid.');
  for (const value of [null, [], Object.create(null), { ...SOURCE, pages: [1], extra: true }]) {
    invalid(() => fullPageRedactionPayload(value), 'Automation operation payload is invalid.');
  }
  for (const value of [
    { ...SOURCE, pages: null }, { ...SOURCE, pages: [] },
    { ...SOURCE, pages: Array.from({ length: 101 }, (_, index) => index + 1) },
    { ...SOURCE, pages: new Array(1) }, { ...SOURCE, pages: [0] }, { ...SOURCE, pages: [101] },
    { ...SOURCE, pages: [1.5] },
  ]) invalid(() => fullPageRedactionPayload(value), 'Automation full-page redaction operation payload is invalid.');
  invalid(() => fullPageRedactionPayload({ ...SOURCE, pages: [2, 2] }), 'Automation full-page redaction pages must be unique and ascending.');
  invalid(() => fullPageRedactionPayload({ ...SOURCE, pages: [2, 1] }), 'Automation full-page redaction pages must be unique and ascending.');
});

test('strict payload boundaries reject accessors, symbols, polluted objects, and hostile proxy traps', () => {
  const accessor = { ...SOURCE };
  Object.defineProperty(accessor, 'preset', { enumerable: true, get: () => AUTOMATION_INSPECT_PRESET });
  invalid(() => presetPayload(accessor), 'Automation preset payload is invalid.');
  const symbol = { preset: AUTOMATION_INSPECT_PRESET, ...SOURCE, [Symbol('unexpected')]: true };
  invalid(() => presetPayload(symbol), 'Automation preset payload is invalid.');
  const polluted = Object.assign(Object.create({ inherited: true }), { preset: AUTOMATION_INSPECT_PRESET, ...SOURCE });
  invalid(() => presetPayload(polluted), 'Automation preset payload is invalid.');
  const getter = { ...SOURCE };
  Object.defineProperty(getter, 'sourceId', { enumerable: true, get: () => SOURCE.sourceId });
  assert.deepEqual(sourcePayload(getter), SOURCE);
  const proxied = new Proxy({ preset: AUTOMATION_INSPECT_PRESET, ...SOURCE }, {
    ownKeys() { throw new Error('proxy trap'); },
  });
  invalid(() => presetPayload(proxied), 'Automation preset payload is invalid.');
});

test('root property and proxy trap schedules remain stable for every payload contract', () => {
  const cases = [
    ['preset', presetPayload, { preset: AUTOMATION_INSPECT_PRESET, ...SOURCE }, [
      'preset.getPrototypeOf', 'preset.ownKeys', 'preset.getOwnPropertyDescriptor:preset',
      'preset.getOwnPropertyDescriptor:sourceId', 'preset.getOwnPropertyDescriptor:sha256', 'preset.ownKeys',
    ]],
    ['source', sourcePayload, { ...SOURCE }, [
      'source.getPrototypeOf', 'source.ownKeys', 'source.getOwnPropertyDescriptor:sourceId', 'source.getOwnPropertyDescriptor:sha256',
      'source.get:sourceId', 'source.get:sha256', 'source.get:sourceId', 'source.get:sha256',
    ]],
    ['ocr', ocrPayload, { ...OCR }, [
      'ocr.getPrototypeOf', 'ocr.ownKeys', 'ocr.getOwnPropertyDescriptor:sourceId', 'ocr.getOwnPropertyDescriptor:sha256',
      'ocr.getOwnPropertyDescriptor:language', 'ocr.getOwnPropertyDescriptor:cleanupPreset', 'ocr.getOwnPropertyDescriptor:segmentation',
      'ocr.getOwnPropertyDescriptor:userDictionary', 'ocr.get:sourceId', 'ocr.get:sha256', 'ocr.get:language', 'ocr.get:language',
      'ocr.getPrototypeOf', 'ocr.get:language', 'ocr.get:cleanupPreset', 'ocr.get:segmentation', 'ocr.get:userDictionary',
      'ocr.get:sourceId', 'ocr.get:sha256',
    ]],
    ['output', outputIntentPayload, { ...SOURCE, profile: OUTPUT_INTENT_PROFILE }, [
      'output.getPrototypeOf', 'output.ownKeys', 'output.getOwnPropertyDescriptor:sourceId', 'output.getOwnPropertyDescriptor:sha256',
      'output.getOwnPropertyDescriptor:profile', 'output.get:profile', 'output.get:sourceId', 'output.get:sha256',
      'output.get:sourceId', 'output.get:sha256',
    ]],
    ['full', fullPageRedactionPayload, { ...SOURCE, pages: [1, 2] }, [
      'full.getPrototypeOf', 'full.ownKeys', 'full.getOwnPropertyDescriptor:sourceId', 'full.getOwnPropertyDescriptor:sha256',
      'full.getOwnPropertyDescriptor:pages', 'full.get:sourceId', 'full.get:sha256', 'full.get:pages', 'full.get:pages',
      'full.get:pages', 'full.get:pages', 'full.get:sourceId', 'full.get:sha256',
    ]],
  ];
  for (const [label, normalize, target, expected] of cases) {
    const trace = [];
    normalize(tracked(target, trace, label));
    assert.deepEqual(trace, expected);
  }
});

test('full-page redaction retains eager nested page reads and rejects a bad source before pages', () => {
  const trace = [];
  const pages = tracked([1, 2], trace, 'pages');
  fullPageRedactionPayload(tracked({ ...SOURCE, pages }, trace, 'full'));
  assert.deepEqual(trace, [
    'full.getPrototypeOf', 'full.ownKeys', 'full.getOwnPropertyDescriptor:sourceId', 'full.getOwnPropertyDescriptor:sha256',
    'full.getOwnPropertyDescriptor:pages', 'full.get:sourceId', 'full.get:sha256', 'full.get:pages', 'full.get:pages',
    'pages.get:length', 'full.get:pages', 'pages.get:length', 'full.get:pages', 'pages.get:Symbol(Symbol.iterator)',
    'pages.get:length', 'pages.get:0', 'pages.get:length', 'pages.get:1', 'pages.get:length', 'full.get:sourceId', 'full.get:sha256',
  ]);
  const blocked = [];
  const payload = { sourceId: 'bad id', sha256: SHA };
  Object.defineProperty(payload, 'pages', { enumerable: true, get() { blocked.push('pages'); return [1]; } });
  invalid(() => fullPageRedactionPayload(payload), 'Automation operation payload is invalid.');
  assert.deepEqual(blocked, []);
});
