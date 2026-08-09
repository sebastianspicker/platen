import { createHash } from 'node:crypto';
import { HostError } from '../../host/host-error.mjs';
import { AUTOMATION_JS_PROFILE } from '../../host/automation/automation-js-contract.mjs';
import {
  AUTOMATION_RECIPE_CLI_GRANT,
  AUTOMATION_RECIPE_CLI_PRINCIPAL,
} from '../automation-recipe-authority.mjs';
import {
  AUTOMATION_CONDITIONAL_CLI_GRANT,
  AUTOMATION_CONDITIONAL_CLI_PRINCIPAL,
} from '../automation-conditional-authority.mjs';
import { normalizeAutomationConditionalExecuteRequest } from '../../host/automation/automation-conditional-workflow-contract.mjs';

function recipeRunRequest(source, command) {
  const recipe = Object.freeze({ id: command.recipe, version: 1, repeat: command.repeat });
  const idempotencyKey = command.idempotencyKey
    ?? `automation-recipe:${source.sha256}:${recipe.id}:1:${recipe.repeat}`;
  return Object.freeze({
    profile: AUTOMATION_JS_PROFILE,
    principal: AUTOMATION_RECIPE_CLI_PRINCIPAL,
    grant: AUTOMATION_RECIPE_CLI_GRANT,
    source: Object.freeze({ id: source.id, sha256: source.sha256 }),
    recipe,
    idempotencyKey,
  });
}

function recipeExecutionId(receipt) {
  return typeof receipt?.executionId === 'string' ? receipt.executionId
    : typeof receipt?.receipt?.executionId === 'string' ? receipt.receipt.executionId : null;
}

function recipeBoundActionRequest(request, executionReceipt) {
  const executionId = recipeExecutionId(executionReceipt);
  if (!executionId) return null;
  return Object.freeze({
    profile: request.profile,
    principal: request.principal,
    grant: request.grant,
    executionId,
  });
}

function combineRecipeFailures(primary, cleanup) {
  if (primary && cleanup.length > 0) {
    return new AggregateError([primary, ...cleanup], 'Automation recipe execution and cleanup failed.');
  }
  if (primary) return primary;
  if (cleanup.length === 1) return cleanup[0];
  if (cleanup.length > 1) return new AggregateError(cleanup, 'Automation recipe cleanup failed.');
  return null;
}

export async function runAutomationRecipeCommand(application, automation, command, stdout, runtime, signal) {
  const document = await runtime.uploadPdf(application, command.input, signal);
  let source = null;
  let committed = false;
  let handedOff = false;
  let executionReceipt = null;
  let releaseReceipt = null;
  let primary = null;
  const cleanup = [];
  let request = null;
  try {
    runtime.cancelled(signal);
    source = await automation.sources.stageDocument({
      store: application.store, documentId: document.id, signal,
    });
    request = recipeRunRequest(source, command);
    runtime.cancelled(signal);
    await automation.sources.commit(source);
    committed = true;
    runtime.cancelled(signal);
    executionReceipt = await automation.automationJs.execute(request, { signal });
    runtime.cancelled(signal);
    const bound = recipeBoundActionRequest(request, executionReceipt);
    if (!bound) throw new HostError('AUTOMATION_JS_RESULT_INVALID', 'Declarative recipe execution receipt did not include an execution identity.', 502);
    releaseReceipt = await automation.automationJs.release(bound);
    handedOff = true;
    const envelope = Object.freeze({
      kind: 'automation-declarative-recipe-run',
      executionReceipt,
      releaseReceipt,
      source: Object.freeze({ id: source.id, sha256: source.sha256, size: source.size }),
    });
    await runtime.outputValue(command, stdout, envelope, signal);
  } catch (error) {
    primary = error;
    if (!handedOff) {
      const bound = recipeBoundActionRequest(request, executionReceipt ?? error);
      if (bound && typeof automation.automationJs.cancel === 'function') {
        try { await automation.automationJs.cancel(bound); } catch (cleanupError) { cleanup.push(cleanupError); }
      }
      if (source && !committed) {
        try { await automation.sources.discardCreated(source); } catch (cleanupError) { cleanup.push(cleanupError); }
      }
    }
  } finally {
    try { await application.store.deleteDocument(document.id); }
    catch (cleanupError) { cleanup.push(cleanupError); }
  }
  const failure = combineRecipeFailures(primary, cleanup);
  if (failure) throw failure;
}

async function readConditionalWorkflow(command, runtime, signal) {
  let selected = null;
  try {
    selected = await runtime.readLocalInputBytes(command.workflow, {
      minimumBytes: 2,
      maximumBytes: 65_536,
      extension: '.json',
      signal,
    });
    return JSON.parse(selected.bytes.toString('utf8'));
  } finally {
    selected?.bytes?.fill(0);
  }
}

function conditionalRunRequest(source, workflow, command) {
  const binding = {
    principal: AUTOMATION_CONDITIONAL_CLI_PRINCIPAL,
    grant: AUTOMATION_CONDITIONAL_CLI_GRANT,
    source: Object.freeze({ id: source.id, sha256: source.sha256 }),
  };
  const normalized = normalizeAutomationConditionalExecuteRequest({
    ...binding,
    workflow,
    idempotencyKey: command.idempotencyKey ?? 'conditional-canonicalization',
  });
  const idempotencyKey = command.idempotencyKey
    ?? `conditional-${createHash('sha256').update(JSON.stringify([source.sha256, normalized.workflow]), 'utf8').digest('hex')}`;
  return Object.freeze({
    ...binding,
    workflow: normalized.workflow,
    idempotencyKey,
  });
}

function conditionalExecutionId(receipt) {
  return typeof receipt?.executionId === 'string' ? receipt.executionId
    : typeof receipt?.receipt?.executionId === 'string' ? receipt.receipt.executionId : null;
}

function conditionalBoundActionRequest(request, executionReceipt) {
  const executionId = conditionalExecutionId(executionReceipt);
  if (!executionId) return null;
  return Object.freeze({
    principal: request.principal,
    grant: request.grant,
    executionId,
  });
}

function combineConditionalFailures(primary, cleanup) {
  if (primary && cleanup.length > 0) {
    return new AggregateError([primary, ...cleanup], 'Conditional automation execution and cleanup failed.');
  }
  if (primary) return primary;
  if (cleanup.length === 1) return cleanup[0];
  if (cleanup.length > 1) return new AggregateError(cleanup, 'Conditional automation cleanup failed.');
  return null;
}

export async function runAutomationConditionalCommand(application, automation, command, stdout, runtime, signal) {
  const workflow = await readConditionalWorkflow(command, runtime, signal);
  const document = await runtime.uploadPdf(application, command.input, signal);
  let source = null;
  let committed = false;
  let handedOff = false;
  let executionReceipt = null;
  let releaseReceipt = null;
  let request = null;
  let primary = null;
  const cleanup = [];
  try {
    runtime.cancelled(signal);
    source = await automation.sources.stageDocument({
      store: application.store, documentId: document.id, signal,
    });
    request = conditionalRunRequest(source, workflow, command);
    runtime.cancelled(signal);
    await automation.sources.commit(source);
    committed = true;
    runtime.cancelled(signal);
    executionReceipt = await automation.conditionalWorkflows.execute(request, { signal });
    runtime.cancelled(signal);
    const bound = conditionalBoundActionRequest(request, executionReceipt);
    if (!bound) throw new HostError('AUTOMATION_CONDITIONAL_RESULT_INVALID', 'Conditional execution receipt did not include an execution identity.', 502);
    releaseReceipt = await automation.conditionalWorkflows.release(bound);
    handedOff = true;
    const envelope = Object.freeze({
      kind: 'automation-declarative-conditional-run',
      executionReceipt,
      releaseReceipt,
      source: Object.freeze({ id: source.id, sha256: source.sha256, size: source.size }),
    });
    await runtime.outputValue(command, stdout, envelope, signal);
  } catch (error) {
    primary = error;
    if (!handedOff) {
      const bound = conditionalBoundActionRequest(request, executionReceipt ?? error);
      if (bound && typeof automation.conditionalWorkflows.cancel === 'function') {
        try { await automation.conditionalWorkflows.cancel(bound); } catch (cleanupError) { cleanup.push(cleanupError); }
      }
      if (source && !committed) {
        try { await automation.sources.discardCreated(source); } catch (cleanupError) { cleanup.push(cleanupError); }
      }
    }
  } finally {
    try { await application.store.deleteDocument(document.id); }
    catch (cleanupError) { cleanup.push(cleanupError); }
  }
  const failure = combineConditionalFailures(primary, cleanup);
  if (failure) throw failure;
}

export async function runAutomationDeclarativeCommand(application, automation, command, stdout, runtime, signal) {
  if (command.command === 'automation-run-recipe') {
    if (!automation.automationJs || typeof automation.automationJs.execute !== 'function'
      || typeof automation.automationJs.release !== 'function') {
      throw new HostError('AUTOMATION_JS_UNAVAILABLE', 'The declarative automation recipe service is unavailable.', 503);
    }
    await runAutomationRecipeCommand(application, automation, command, stdout, runtime, signal);
    return true;
  }
  if (command.command === 'automation-run-conditional') {
    if (!automation.conditionalWorkflows
      || typeof automation.conditionalWorkflows.execute !== 'function'
      || typeof automation.conditionalWorkflows.release !== 'function') {
      throw new HostError('AUTOMATION_CONDITIONAL_UNAVAILABLE', 'The conditional automation workflow service is unavailable.', 503);
    }
    await runAutomationConditionalCommand(application, automation, command, stdout, runtime, signal);
    return true;
  }
  return false;
}
