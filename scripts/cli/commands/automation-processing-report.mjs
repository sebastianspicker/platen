import { createHash } from 'node:crypto';
import { HostError } from '../../host/host-error.mjs';
import { checkedApiJob } from '../../host/professional-capability/automation-headless-contract.mjs';

export async function runAutomationProcessingReport(automation, command, stdout, runtime, signal) {
  if (!automation.api || typeof automation.api.status !== 'function') throw new HostError('AUTOMATION_SERVICE_REQUIRED', 'Automation API status is unavailable.', 503);
  const grant = Object.freeze({ grantId: command.grantId, principal: command.principal }); const jobs = [];
  for (const jobId of command.jobIds) {
    runtime.cancelled(signal);
    jobs.push(checkedApiJob(await automation.api.status({ principal: command.principal, grant, jobId }), jobId));
  }
  runtime.cancelled(signal);
  const counts = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) counts[job.status] += 1;
  const report = Object.freeze({ kind: 'automation-processing-report', total: jobs.length, ...counts, statuses: Object.freeze(jobs), successRate: jobs.length ? counts.completed / jobs.length : 0 });
  await runtime.outputValue(command, stdout, Object.freeze({ report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), localOnly: true }), signal);
}
