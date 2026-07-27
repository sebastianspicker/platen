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
  if (await handleRedactionPlanRoute(context)) return true;
  const handler = routeHandlers[context.operation];
  if (!handler) return false;
  await handler(context);
  return true;
}
