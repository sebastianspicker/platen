import {
  canonicalQueueJson,
  queuePolicySnapshot,
} from './durable-local-job-record.mjs';

const LEGACY_AUTOMATION_TYPES = Object.freeze([
  'automation_full_page_redaction_v1',
  'automation_inspect_v1',
  'automation_ocr_v1',
  'automation_output_intent_v1',
]);
const SEQUENCE_AUTOMATION_TYPES = Object.freeze([
  ...LEGACY_AUTOMATION_TYPES,
  'automation_sequence_v1',
].sort());

export function migrateAutomationSequencePolicy(state, runtime) {
  const expected = queuePolicySnapshot(runtime.allowedJobTypes, runtime.limits);
  if (canonicalQueueJson(state.policy) === canonicalQueueJson(expected)) return false;
  const exactTypeAddition = canonicalQueueJson(runtime.allowedJobTypes)
      === canonicalQueueJson(SEQUENCE_AUTOMATION_TYPES)
    && canonicalQueueJson(state.policy?.allowedJobTypes)
      === canonicalQueueJson(LEGACY_AUTOMATION_TYPES);
  const exactLimits = canonicalQueueJson(state.policy?.limits)
    === canonicalQueueJson(expected.limits);
  const legacyJobsOnly = Array.isArray(state.jobs)
    && state.jobs.every((job) => LEGACY_AUTOMATION_TYPES.includes(job?.type));
  if (!exactTypeAddition || !exactLimits || !legacyJobsOnly) return false;
  state.policy = expected;
  return true;
}

export { LEGACY_AUTOMATION_TYPES, SEQUENCE_AUTOMATION_TYPES };
