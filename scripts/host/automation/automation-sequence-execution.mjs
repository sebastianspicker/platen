import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_PRESET,
  AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE,
} from './automation-operation-contract.mjs';
import {
  AUTOMATION_SEQUENCE_TYPE,
  automationSequenceDescriptor,
  automationSequenceRequest,
} from './automation-sequence-contract.mjs';

function cancelled(signal) {
  if (signal?.aborted) {
    throw new HostError('JOB_CANCELLED', 'Automation sequence was cancelled.', 499);
  }
}

function terminalType(descriptor) {
  return descriptor.terminalPreset === AUTOMATION_OCR_PRESET
    ? AUTOMATION_OCR_TYPE
    : AUTOMATION_OUTPUT_INTENT_TYPE;
}

function checkedTerminal(terminal) {
  const output = terminal?.pendingOutput;
  const durable = terminal?.receipt?.durableOutput;
  if (!output || !durable || durable.id !== output.id
    || durable.sha256 !== output.sha256 || durable.size !== output.size) {
    throw new HostError(
      'AUTOMATION_RESULT_INVALID',
      'Automation sequence terminal output is invalid.',
      502,
    );
  }
  return Object.freeze({
    id: durable.id,
    size: durable.size,
    sha256: durable.sha256,
  });
}

export async function executeAutomationSequence({
  payload, dependencies, validate, execute,
}) {
  const request = automationSequenceRequest(payload);
  const descriptor = automationSequenceDescriptor(request.sequenceId);
  if (descriptor.sequenceVersion !== request.sequenceVersion
    || descriptor.steps.length !== 2 || descriptor.steps[0] !== 'inspect-local-v1'
    || descriptor.steps[1] !== descriptor.terminalPreset) {
    throw new HostError(
      'INVALID_AUTOMATION_OPERATION',
      'Automation sequence descriptor is invalid.',
      400,
    );
  }
  const terminalOperation = terminalType(descriptor);
  validate(AUTOMATION_INSPECT_TYPE, dependencies);
  validate(terminalOperation, dependencies);
  cancelled(dependencies.signal);
  const source = Object.freeze({
    sourceId: request.sourceId,
    sha256: request.sha256,
  });
  const inspection = await execute(AUTOMATION_INSPECT_TYPE, source, dependencies);
  cancelled(dependencies.signal);
  let terminal = null;
  try {
    terminal = await execute(terminalOperation, {
      ...source,
      preset: descriptor.terminalPreset,
    }, dependencies);
    cancelled(dependencies.signal);
    const durableOutput = checkedTerminal(terminal);
    const steps = Object.freeze([
      Object.freeze({
        position: 1,
        preset: descriptor.steps[0],
        operation: AUTOMATION_INSPECT_TYPE,
        status: 'completed',
        receipt: inspection,
      }),
      Object.freeze({
        position: 2,
        preset: descriptor.steps[1],
        operation: terminalOperation,
        status: 'completed',
        receipt: terminal.receipt,
      }),
    ]);
    return Object.freeze({
      receipt: Object.freeze({
        schemaVersion: 1,
        operation: AUTOMATION_SEQUENCE_TYPE,
        sequenceId: descriptor.id,
        sequenceVersion: descriptor.sequenceVersion,
        source,
        steps,
        durableOutput,
        sourceBound: true,
        localOnly: true,
      }),
      pendingOutput: terminal.pendingOutput,
    });
  } catch (error) {
    if (!terminal?.pendingOutput) throw error;
    try {
      await dependencies.sources.discardCreatedOutput(terminal.pendingOutput);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Automation sequence and durable-output cleanup failed.',
      );
    }
    throw error;
  }
}
