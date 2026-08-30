import { invalidOperation, OPAQUE_ID, SHA256, AUTOMATION_OCR_PRESET, AUTOMATION_OUTPUT_INTENT_PRESET } from './automation-operation-contract.mjs';
import { types as nodeTypes } from 'node:util';

export const AUTOMATION_SEQUENCE_TYPE = 'automation_sequence_v1';
export const AUTOMATION_SEQUENCE_IDS = Object.freeze(['inspect-then-ocr-english-v1', 'inspect-then-output-intent-cmyk-v1']);
const DESCRIPTORS = new Map([
  ['inspect-then-ocr-english-v1', Object.freeze({ schemaVersion: 1, id: 'inspect-then-ocr-english-v1', sequenceVersion: 1, steps: Object.freeze(['inspect-local-v1', AUTOMATION_OCR_PRESET]), terminalPreset: AUTOMATION_OCR_PRESET })],
  ['inspect-then-output-intent-cmyk-v1', Object.freeze({ schemaVersion: 1, id: 'inspect-then-output-intent-cmyk-v1', sequenceVersion: 1, steps: Object.freeze(['inspect-local-v1', AUTOMATION_OUTPUT_INTENT_PRESET]), terminalPreset: AUTOMATION_OUTPUT_INTENT_PRESET })],
]);
export function automationSequenceDescriptor(id) { const descriptor = DESCRIPTORS.get(id); if (!descriptor) invalidOperation('Automation sequence is not allowlisted.'); return descriptor; }
export function automationSequenceRequest(payload) {
  if (!payload || nodeTypes.isProxy(payload) || Object.getPrototypeOf(payload) !== Object.prototype) invalidOperation('Automation sequence payload is invalid.');
  const descriptors = Object.getOwnPropertyDescriptors(payload); const keys = Reflect.ownKeys(payload);
  if (keys.length !== 4 || keys.some((key) => typeof key !== 'string' || !descriptors[key] || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true) || keys.sort().join(',') !== 'sequenceId,sequenceVersion,sha256,sourceId') invalidOperation('Automation sequence payload is invalid.');
  const data = { sourceId: descriptors.sourceId.value, sha256: descriptors.sha256.value, sequenceId: descriptors.sequenceId.value, sequenceVersion: descriptors.sequenceVersion.value };
  if (!OPAQUE_ID.test(data.sourceId) || !SHA256.test(data.sha256) || data.sequenceVersion !== 1) invalidOperation('Automation sequence payload is invalid.');
  return Object.freeze({ ...data, sequenceId: automationSequenceDescriptor(data.sequenceId).id });
}
