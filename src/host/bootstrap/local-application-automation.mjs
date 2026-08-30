import { join } from 'node:path';
import { AutomationSourceStore } from '../application/automation/automation-source-store.mjs';
import {
  AutomationOperationRegistry,
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE,
  AUTOMATION_FULL_PAGE_REDACTION_TYPE,
} from '../application/automation/automation-operation-registry.mjs';
import { AUTOMATION_SEQUENCE_TYPE } from '../application/automation/automation-sequence-contract.mjs';
import { AutomationWorker } from '../application/automation/automation-worker.mjs';
import { DurableLocalJobQueue } from '../application/automation/durable-local-job-queue.mjs';
import { AutomationApiService } from '../application/automation/automation-api-service.mjs';
import { AutomationScheduleStore } from '../application/automation/automation-scheduled-jobs-store.mjs';
import { AutomationScheduledJobsService } from '../application/automation/automation-scheduled-jobs-service.mjs';
import { AutomationConditionalWorkflowService } from '../application/automation/automation-conditional-workflow-service.mjs';
import { LocalConditionalWorkflowFactsProvider } from '../application/automation/automation-conditional-workflow-runtime.mjs';
import { AutomationBatchPrintService } from '../application/automation/automation-batch-print-service.mjs';
import { AutomationWebhookService } from '../application/automation/automation-webhook-service.mjs';
import { AutomationJsService } from '../application/automation/automation-js-service.mjs';
import { AutomationPreflightServerService } from '../application/automation/automation-preflight-server-service.mjs';
import { HostError } from '../platform/runtime/host-error.mjs';

export async function createLocalApplicationAutomation({
  automationRoot, store, service, outputIntentService = null, fullPageRedaction = null,
  automationCapabilityAuthority = null,
  automationPrinterInventory = undefined, automationPrintAdapter = undefined,
  automationWebhookDestinationInventory = undefined, automationWebhookDeliveryAdapter = undefined,
  automationWebhookEventFactsResolver = undefined,
  automationPreflightEngine = undefined,
}) {
  if (automationRoot === null) return null;
  let queue = null;
  let scheduleStore = null;
  try {
    const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
    queue = await new DurableLocalJobQueue({
      root: join(automationRoot, 'queue'),
      allowedJobTypes: [
        AUTOMATION_INSPECT_TYPE,
        AUTOMATION_OCR_TYPE,
        AUTOMATION_OUTPUT_INTENT_TYPE,
        AUTOMATION_FULL_PAGE_REDACTION_TYPE,
        AUTOMATION_SEQUENCE_TYPE,
      ],
    }).initialize();
    const recoveryReferences = await queue.recoveryReferences();
    await sources.recoverTransactions(recoveryReferences);
    await queue.acknowledgeDiscarded(recoveryReferences.discard.filter((ref) => ref.kind === 'output'));
    const registry = new AutomationOperationRegistry();
    const authority = automationCapabilityAuthority ?? Object.freeze({
      authorize() {
        throw new HostError(
          'AUTOMATION_API_CAPABILITY_DENIED',
          'Automation API capability grant does not authorize this action.',
          403,
        );
      },
    });
    const worker = new AutomationWorker({
      queue, registry, sources, store, service, outputIntentService, fullPageRedaction,
    });
    scheduleStore = await new AutomationScheduleStore({ root: join(automationRoot, 'schedules') }).initialize();
    const api = new AutomationApiService({ queue, registry, sources, worker, authority });
    const conditionalWorkflows = new AutomationConditionalWorkflowService({
      api, authority,
      factsProvider: new LocalConditionalWorkflowFactsProvider({ sources, store, service }),
    });
    const batchPrint = new AutomationBatchPrintService({ sources, authority,
      printerInventory: automationPrinterInventory, adapter: automationPrintAdapter });
    const webhooks = new AutomationWebhookService({ authority,
      destinationInventory: automationWebhookDestinationInventory,
      eventFactsResolver: automationWebhookEventFactsResolver,
      adapter: automationWebhookDeliveryAdapter });
    const automationJs = new AutomationJsService({ api, authority });
    const preflightServer = new AutomationPreflightServerService({ sources, authority,
      engine: automationPreflightEngine });
    return Object.freeze({
      sources,
      queue,
      registry,
      worker,
      api,
      scheduledJobs: new AutomationScheduledJobsService({ store: scheduleStore, api, authority }),
      conditionalWorkflows,
      batchPrint,
      webhooks,
      automationJs,
      preflightServer,
    });
  } catch (error) {
    const failures = [error];
    try { await queue?.close(); } catch (cleanupError) { failures.push(cleanupError); }
    try { await scheduleStore?.close(); } catch (cleanupError) { failures.push(cleanupError); }
    try { await store.dispose(); } catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Automation setup and cleanup failed.');
    }
    throw error;
  }
}
