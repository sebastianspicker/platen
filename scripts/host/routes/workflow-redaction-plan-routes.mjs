import { HostError } from '../host-error.mjs';

const BODY_LIMIT = 32 * 1024;

export async function handleRedactionPlanRoute(context) {
  const { request, response, url, documentId, operation, processing, redactionPlans, redactionPlanReports, method, readJson, json } = context;
  if (!['redaction-plan', 'redaction-application', 'redaction-report'].includes(operation)) return false;
  if (url.search !== '') throw new HostError('INVALID_REDACTION_PLAN_REQUEST', 'Redaction-plan routes do not accept query parameters.', 400);
  const service = operation === 'redaction-report' ? redactionPlanReports : redactionPlans;
  if (!service) throw new HostError(
    operation === 'redaction-report' ? 'REDACTION_PLAN_REPORT_UNAVAILABLE' : 'REDACTION_PLAN_UNAVAILABLE',
    operation === 'redaction-report' ? 'Source-bound redaction reporting is unavailable.' : 'Source-bound redaction planning is unavailable.',
    503,
  );
  method(request, 'POST');
  const body = await readJson(request, BODY_LIMIT);
  const result = operation === 'redaction-report'
    ? await service.report(documentId, body, processing)
    : operation === 'redaction-plan'
    ? await redactionPlans.createPlan(documentId, body, processing)
    : await redactionPlans.applyPlan(documentId, body, processing);
  json(response, operation === 'redaction-report' ? 200 : 201, result);
  return true;
}
