import { HostError } from '../host-error.mjs';
import { ACCESSIBILITY_REMEDIATION_MEDIA_TYPE } from '../accessibility-remediation-service.mjs';
import { SUPPORTED_STANDARD_PROFILES } from '../verapdf-validation-service.mjs';

function exactJsonObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

export async function handleAccessibilityReviewRoute(context) {
  const {
    request, response, documentId, processing, accessibilityReviews, method, readJson, json,
  } = context;
  if (!accessibilityReviews) {
    throw new HostError(
      'ACCESSIBILITY_REVIEW_UNAVAILABLE',
      'Local accessibility review is unavailable.',
      503,
    );
  }
  method(request, 'POST');
  const body = await readJson(request);
  if (!exactJsonObject(body, ['profile']) || body.profile !== 'basic-local-review') {
    throw new HostError(
      'INVALID_ACCESSIBILITY_REVIEW_OPTIONS',
      'Accessibility review requires exactly {"profile":"basic-local-review"}.',
      400,
    );
  }
  json(response, 200, { report: await accessibilityReviews.review(documentId, processing) });
}

export async function handleAccessibilityProposalRoute(context) {
  const {
    request, response, url, documentId, accessibilityRemediations, readJson, json, write,
  } = context;
  if (!accessibilityRemediations) {
    throw new HostError(
      'ACCESSIBILITY_REMEDIATION_UNAVAILABLE',
      'Local accessibility remediation proposals are unavailable.',
      503,
    );
  }
  if (request.method === 'POST') {
    if ([...url.searchParams].length) {
      throw new HostError(
        'INVALID_PARAMETER',
        'Accessibility proposal creation does not accept query parameters.',
        400,
      );
    }
    const proposal = await accessibilityRemediations.createProposal(documentId, await readJson(request));
    json(response, 201, { proposal });
    return;
  }
  if (request.method === 'GET') {
    const hasOneId = url.searchParams.getAll('proposalId').length === 1;
    const hasOnlyId = [...url.searchParams.keys()].every((key) => key === 'proposalId');
    if (!hasOneId || !hasOnlyId) {
      throw new HostError(
        'INVALID_PARAMETER',
        'Accessibility proposal export requires exactly one proposalId.',
        400,
      );
    }
    const proposal = accessibilityRemediations.exportProposal(
      documentId,
      url.searchParams.get('proposalId'),
    );
    write(response, 200, proposal, `${ACCESSIBILITY_REMEDIATION_MEDIA_TYPE}; charset=utf-8`);
    return;
  }
  throw new HostError(
    'METHOD_NOT_ALLOWED',
    'Accessibility proposals support POST creation and GET export.',
    405,
  );
}

export async function handleStandardsValidationRoute(context) {
  const {
    request, response, url, documentId, processing, standardsValidations, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Standards validation does not accept query parameters.', 400);
  }
  const body = await readJson(request);
  if (!exactJsonObject(body, ['profile']) || typeof body.profile !== 'string') {
    throw new HostError(
      'INVALID_STANDARD_VALIDATION_OPTIONS',
      'Standards validation requires exactly one fixed profile.',
      400,
    );
  }
  if (body.profile === 'pdfx') {
    throw new HostError(
      'STANDARD_UNSUPPORTED',
      'PDF/X validation requires a separate authoritative engine.',
      422,
    );
  }
  if (!SUPPORTED_STANDARD_PROFILES.includes(body.profile)) {
    throw new HostError(
      'INVALID_STANDARD_PROFILE',
      'Choose a supported fixed PDF/A or PDF/UA profile.',
      400,
    );
  }
  if (!standardsValidations) {
    throw new HostError(
      'STANDARDS_VALIDATION_UNAVAILABLE',
      'A trusted pinned local veraPDF bundle is not staged.',
      503,
    );
  }
  const report = await standardsValidations.validate(
    documentId,
    { profile: body.profile, ...processing },
  );
  json(response, 200, { report });
}
