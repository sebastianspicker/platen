import {
  automationBatchPrint,
  automationJobQueueRetry,
  automationPreflightServer,
  automationProcessingReports,
  automationVariablesPresets,
  automationWebhooks,
} from './automation-headless-local.mjs';
import {
  automationActionSequences,
  automationConditionalWorkflows,
  automationJavascript,
  automationScheduledJobs,
  automationWatchFolders,
} from './automation-headless-workflows.mjs';

export {
  automationActionSequences,
  automationBatchPrint,
  automationConditionalWorkflows,
  automationJavascript,
  automationJobQueueRetry,
  automationPreflightServer,
  automationProcessingReports,
  automationScheduledJobs,
  automationVariablesPresets,
  automationWatchFolders,
  automationWebhooks,
};

export const handlers = Object.freeze({
  async 'automation.watch-folders'(ctx = {}) { return automationWatchFolders(ctx); },
  async 'automation.action-sequences'(ctx = {}) { return automationActionSequences(ctx); },
  async 'automation.javascript'(ctx = {}) { return automationJavascript(ctx); },
  async 'automation.scheduled-jobs'(ctx = {}) { return automationScheduledJobs(ctx); },
  async 'automation.conditional-workflows'(ctx = {}) { return automationConditionalWorkflows(ctx); },
  async 'automation.variables-presets'(ctx = {}) { return automationVariablesPresets(ctx); },
  async 'automation.job-queue-retry'(ctx = {}) { return automationJobQueueRetry(ctx); },
  async 'automation.webhooks'(ctx = {}) { return automationWebhooks(ctx); },
  async 'automation.processing-reports'(ctx = {}) { return automationProcessingReports(ctx); },
  async 'automation.preflight-server'(ctx = {}) { return automationPreflightServer(ctx); },
  async 'automation.batch-print'(ctx = {}) { return automationBatchPrint(ctx); },
});
