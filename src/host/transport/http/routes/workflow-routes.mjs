import {
  handleComparisonBatchRoute,
  handleComparisonRoute,
  handleRasterMutationRoute,
} from './workflow-mutation-routes.mjs';
import { handleOutputIntentRoute, handlePrepressRoute } from './workflow-prepress-route.mjs';
import { handleRedactionPlanRoute } from './workflow-redaction-plan-routes.mjs';
import {
  handleAccessibilityProposalRoute,
  handleAccessibilityReviewRoute,
  handleStandardsValidationRoute,
} from './workflow-review-routes.mjs';
import { handleProfessionalPrintInspectionRoute } from './professional-print-inspection-routes.mjs';
import { handleProfessionalPrintTransparencyRoute } from './professional-print-transparency-routes.mjs';

const routeHandlers = Object.freeze({
  mutation: handleRasterMutationRoute,
  compare: handleComparisonRoute,
  'prepress/output-intent': handleOutputIntentRoute,
  prepress: handlePrepressRoute,
  'accessibility-review': handleAccessibilityReviewRoute,
  'accessibility-proposal': handleAccessibilityProposalRoute,
  'standards-validation': handleStandardsValidationRoute,
});

export { handleComparisonBatchRoute };

export async function handleWorkflowRoute(context) {
  if (await handleProfessionalPrintTransparencyRoute({
    ...context,
    bodyLimit: context.limits?.professionalPrintTransparency,
  })) return true;
  if (await handleProfessionalPrintInspectionRoute({
    ...context,
    bodyLimit: context.limits?.professionalPrintInspection,
  })) return true;
  if (await handleRedactionPlanRoute(context)) return true;
  if (!Object.hasOwn(routeHandlers, context.operation)) return false;
  const handler = routeHandlers[context.operation];
  await handler(context);
  return true;
}
