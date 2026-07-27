import { basename } from 'node:path';
import { TAGGED_PDF_REMEDIATION_PROFILE, normalizeTaggedPdfRemediationRequest } from '../../host/pdf-tagged-remediation-contract.mjs';
export async function runTaggedRemediationCommand(application, command, document, stdout, signal, runtime) {
  const planInput = await runtime.readLocalInputBytes(command.planPath, { minimumBytes: 2, maximumBytes: 128 * 1024, extension: '.json', signal });
  let plan; try { plan = JSON.parse(planInput.bytes.toString('utf8')); } catch (error) { runtime.fail('CLI_INVALID_PLAN', 'The tagged-remediation plan must be valid JSON.'); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).length !== 4 || !Object.keys(plan).every((key) => ['plan', 'language', 'title', 'roleMap'].includes(key))) runtime.fail('CLI_INVALID_PLAN', 'The tagged-remediation plan file must contain exactly plan, language, title, and roleMap.');
  const request = { profile: TAGGED_PDF_REMEDIATION_PROFILE, sourceSha256: document.sha256, plan: plan.plan, language: plan.language, title: plan.title, roleMap: plan.roleMap };
  try { normalizeTaggedPdfRemediationRequest(request); } catch { runtime.fail('CLI_INVALID_PLAN', 'The tagged-remediation plan is outside the bounded semantic contract.'); }
  const result = await application.taggedRemediation.update(document.id, request, { sourceSha256: document.sha256, signal }); runtime.cancelled(signal);
  const artifact = application.store.getArtifact(result.artifact.id); await runtime.copyExclusive(artifact.filePath, command.output); await runtime.emit(stdout, { ...result, artifact: { ...result.artifact, output: basename(command.output) }, localOnly: true });
}
