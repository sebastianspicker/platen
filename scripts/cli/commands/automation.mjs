import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { HostError } from '../../host/host-error.mjs';
import { canonicalWatchDirectory, snapshotPdfDirectory, stablePdfCandidates } from '../../host/watch-folder.mjs';
import { runAutomationCliBatchCommand } from './automation-cli-batch.mjs';
import { runAutomationProcessingReport } from './automation-processing-report.mjs';
import { runAutomationDeclarativeCommand } from './automation-declarative.mjs';
import { runSingleSubmissionCommand } from './automation-submission.mjs';

function requireAutomation(application) {
  if (!application.automation) {
    const error = new Error('Automation commands require an explicit private --automation-root.');
    error.code = 'AUTOMATION_ROOT_REQUIRED';
    throw error;
  }
  return application.automation;
}

async function verifiedOutputBytes(sources, outputId, sha256, runtime, signal) {
  const opened = await sources.openOutputVerified(outputId, sha256);
  const chunks = [];
  let size = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of opened.stream) {
      runtime.cancelled(signal);
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > opened.size) {
        throw new HostError('AUTOMATION_OUTPUT_CORRUPT', 'Automation output exceeded its verified size.', 500);
      }
      hash.update(bytes);
      chunks.push(bytes);
    }
    runtime.cancelled(signal);
    if (size !== opened.size || hash.digest('hex') !== opened.sha256) {
      throw new HostError('AUTOMATION_OUTPUT_CORRUPT', 'Automation output changed while it was copied.', 500);
    }
    return Object.freeze({ metadata: Object.freeze({
      id: opened.id,
      sha256: opened.sha256,
      size: opened.size,
      sourceId: opened.sourceId,
      sourceSha256: opened.sourceSha256,
    }), bytes: Buffer.concat(chunks, size) });
  } finally {
    opened.stream.destroy();
  }
}

async function runOutputCommand(automation, command, stdout, runtime, signal) {
  if (command.command === 'automation-output-list') {
    const outputs = await automation.sources.listOutputs();
    await runtime.outputValue(command, stdout, Object.freeze({
      count: outputs.length,
      outputs,
      localOnly: true,
    }), signal);
    return true;
  }
  if (command.command === 'automation-output-copy') {
    const verified = await verifiedOutputBytes(
      automation.sources, command.outputId, command.sha256, runtime, signal,
    );
    await runtime.writeExclusive(command.output, verified.bytes, signal);
    await runtime.emit(stdout, Object.freeze({
      copied: true,
      output: verified.metadata,
      localOnly: true,
    }));
    return true;
  }
  if (command.command === 'automation-output-delete') {
    const deleted = await automation.sources.deleteOutput(command.outputId, command.sha256);
    await runtime.outputValue(command, stdout, Object.freeze({
      deleted: true,
      output: deleted,
      localOnly: true,
    }), signal);
    return true;
  }
  return false;
}

async function runQueueCommand(automation, command, stdout, runtime, signal) {
  if (command.command === 'automation-run') {
    await runtime.outputValue(command, stdout, await automation.worker.runOnce({ signal }));
    return true;
  }
  if (command.command === 'automation-status') {
    const job = await automation.queue.get(command.jobId);
    await runtime.outputValue(command, stdout, Object.freeze({ job, receipt: job.receipt }));
    return true;
  }
  if (command.command === 'automation-cancel') {
    const job = await automation.worker.cancel(command.jobId);
    await runtime.outputValue(command, stdout, Object.freeze({ job, receipt: job.receipt }));
    return true;
  }
  return false;
}

function scheduleRequest(command) {
  return Object.freeze({
    scheduleId: command.scheduleId,
    principal: command.principal,
    grant: Object.freeze({ grantId: command.grantId, principal: command.principal }),
  });
}

async function runAutomationDiscovery(command, stdout, runtime, signal) {
  const directory = await canonicalWatchDirectory(command.input);
  runtime.cancelled(signal);
  const first = await snapshotPdfDirectory(directory);
  runtime.cancelled(signal);
  const second = await snapshotPdfDirectory(directory);
  const stable = stablePdfCandidates(first, second);
  await runtime.outputValue(command, stdout, Object.freeze({
    directory, firstSnapshot: first, secondSnapshot: second, stableCandidates: stable,
    discoveryOnly: true, stableOnly: true, localOnly: true,
  }), signal);
}

async function runScheduleCommand(automation, command, stdout, runtime, signal) {
  const service = automation.scheduledJobs;
  if (!service) throw new HostError('AUTOMATION_SCHEDULE_UNAVAILABLE', 'The automation schedule service is unavailable.', 503);
  await service.start();
  const request = scheduleRequest(command);
  if (command.command === 'automation-schedule-create') {
    const result = await service.create({ ...request, source: { id: command.sourceId, sha256: command.sha256 }, operation: { id: command.operationId, kind: command.operationKind, pages: command.pages }, firstAt: command.firstAt, intervalMs: command.intervalMs });
    await runtime.outputValue(command, stdout, Object.freeze({ schedule: result, localOnly: true }), signal); return;
  }
  if (command.command === 'automation-schedule-list') {
    await runtime.outputValue(command, stdout, Object.freeze({ schedules: await service.list({ principal: command.principal, grant: request.grant }), localOnly: true }), signal); return;
  }
  if (command.command === 'automation-schedule-tick') {
    const result = await service.tick(command.now ?? undefined);
    await runtime.outputValue(command, stdout, Object.freeze({ schedules: result, tickedAt: command.now, localOnly: true }), signal); return;
  }
  if (command.command === 'automation-schedule-cancel') {
    const result = await service.cancel({ ...request });
    await runtime.outputValue(command, stdout, Object.freeze({ schedule: result, cancelled: true, localOnly: true }), signal); return;
  }
  if (command.command === 'automation-job-status') {
    const schedules = await service.list({ principal: command.principal, grant: request.grant });
    const jobs = [];
    for (const schedule of schedules) for (const run of schedule.runs) if (run.jobId) {
      const job = await automation.queue.get(run.jobId);
      jobs.push(Object.freeze({ scheduleId: schedule.scheduleId, occurrence: run.occurrence, job }));
    }
    const counts = Object.create(null);
    for (const item of jobs) counts[item.job.status] = (counts[item.job.status] ?? 0) + 1;
    await runtime.outputValue(command, stdout, Object.freeze({ principal: command.principal, count: jobs.length, counts: Object.freeze({ ...counts }), jobs: Object.freeze(jobs), localOnly: true }), signal);
  }
}

export async function runAutomationCommand(application, command, stdout, runtime, signal) {
  const automation = requireAutomation(application);
  runtime.cancelled(signal);
  if (command.command === 'automation-watch-discover') { await runAutomationDiscovery(command, stdout, runtime, signal); return; }
  if (command.command === 'automation-processing-report') { await runAutomationProcessingReport(automation, command, stdout, runtime, signal); return; }
  if (await runAutomationCliBatchCommand(application, command, stdout, runtime, signal)) return;
  if (await runAutomationDeclarativeCommand(application, automation, command, stdout, runtime, signal)) return;
  if (await runOutputCommand(automation, command, stdout, runtime, signal)) return;
  if (['automation-submit', 'automation-submit-inspect', 'automation-submit-ocr',
    'automation-submit-output-intent', 'automation-submit-full-page-redaction', 'automation-submit-sequence'].includes(command.command)) {
    await runSingleSubmissionCommand(application, automation, command, stdout, runtime, signal);
    return;
  }
  if (await runQueueCommand(automation, command, stdout, runtime, signal)) return;
  if (command.command.startsWith('automation-schedule-') || command.command === 'automation-job-status') {
    await runScheduleCommand(automation, command, stdout, runtime, signal); return;
  }
  throw new Error(`Unsupported automation command: ${basename(command.command)}.`);
}
