import { HostError } from '../host-error.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

function rejectQueryParameters(url, message) {
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', message, 400);
}

function isLowercaseSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export async function handlePdfkitInspection(context) {
  const { request, response, url, documentId, processing, pdfkitInspections, method, readJson, json } = context;
  if (!pdfkitInspections) throw new HostError('PDFKIT_INSPECTION_UNAVAILABLE', 'The pinned local macOS PDFKit inspector is unavailable.', 503);
  method(request, 'POST');
  rejectQueryParameters(url, 'PDFKit inspection does not accept query parameters.');
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || body.profile !== 'macos-read-only-v1') {
    throw new HostError('INVALID_PDFKIT_INSPECTION_OPTIONS', 'PDFKit inspection requires exactly {"profile":"macos-read-only-v1"}.', 400);
  }
  json(response, 200, { inspection: await pdfkitInspections.inspect(documentId, processing) });
}

export async function handlePdfkitSplitOutline(context) {
  const { request, response, url, documentId, processing, pdfkitOutlineSplits, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  rejectQueryParameters(url, 'Outline splitting does not accept query parameters.');
  const body = await readJson(request);
  if (!exactJsonObject(body, ['profile']) || body.profile !== 'macos-pdfkit-top-level-outline-split-v1') {
    throw new HostError('INVALID_OUTLINE_SPLIT_OPTIONS', 'Outline splitting requires exactly {"profile":"macos-pdfkit-top-level-outline-split-v1"}.', 400);
  }
  if (!pdfkitOutlineSplits) throw new HostError('PDFKIT_OUTLINE_SPLIT_UNAVAILABLE', 'The pinned local macOS PDFKit outline split helper is unavailable.', 503);
  json(response, 201, { artifacts: await pdfkitOutlineSplits.split(documentId, processing) });
}

export async function handlePdfkitMutation(context) {
  const { request, response, url, documentId, processing, store, pdfkitMutations, mutationBodyLimit, method, readJson, json } = context;
  method(request, 'POST');
  rejectQueryParameters(url, 'PDFKit mutation does not accept query parameters.');
  if (!pdfkitMutations) throw new HostError('PDFKIT_MUTATION_UNAVAILABLE', 'The pinned local macOS PDFKit mutation service is unavailable.', 503);
  const body = await readJson(request, mutationBodyLimit);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 3 || Object.keys(body).some((key) => !['profile', 'sourceSha256', 'mutation'].includes(key))
    || !['macos-pdfkit-derived-v1', 'macos-pdfkit-targeted-v1', 'macos-pdfkit-local-goto-v1', 'macos-pdfkit-local-goto-remove-v1', 'macos-pdfkit-outline-v1', 'macos-pdfkit-outline-remove-v1', 'macos-pdfkit-outline-rename-v1', 'macos-pdfkit-line-annotation-v1', 'macos-pdfkit-ink-annotation-v1'].includes(body.profile)
    || !isLowercaseSha256(body.sourceSha256)) {
    throw new HostError('INVALID_PDFKIT_MUTATION_OPTIONS', 'PDFKit mutation requires fixed profile, lowercase source SHA-256, and one bounded mutation.', 400);
  }
  const result = await pdfkitMutations.mutate(documentId, body.mutation, { sourceSha256: body.sourceSha256, signal: processing.signal, profile: body.profile });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return;
  json(response, 201, { result });
}

export async function handlePdfkitTextFieldWidget(context) {
  const { request, response, url, documentId, processing, pdfkitTextFieldWidget, bodyLimit, method, readJson, json, exactJsonObject } = context;
  method(request, 'POST');
  rejectQueryParameters(url, 'PDFKit text-field authoring does not accept query parameters.');
  if (!pdfkitTextFieldWidget) throw new HostError('PDFKIT_TEXT_FIELD_WIDGET_UNAVAILABLE', 'The pinned local macOS PDFKit text-field authoring service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'page', 'rect', 'fieldName', 'defaultValue'])
    || body.profile !== 'macos-pdfkit-acroform-text-field-widget-v1' || !isLowercaseSha256(body.sourceSha256)) {
    throw new HostError('INVALID_PDFKIT_TEXT_FIELD_WIDGET_OPTIONS', 'Text-field authoring requires the fixed profile, source digest, page, rectangle, field name, and default value.', 400);
  }
  json(response, 201, { result: await pdfkitTextFieldWidget.addTextFieldWidget(documentId, {
    sourceSha256: body.sourceSha256, page: body.page, rect: body.rect, fieldName: body.fieldName, defaultValue: body.defaultValue,
    signal: processing.signal,
  }) });
}

export async function handlePdfkitProtection(context) {
  const { request, response, url, documentId, processing, pdfkitProtection, protectionBodyLimit, method, readJson, json } = context;
  method(request, 'POST');
  rejectQueryParameters(url, 'PDFKit protection does not accept query parameters.');
  if (!pdfkitProtection) throw new HostError('PDFKIT_PROTECTION_UNAVAILABLE', 'The pinned local macOS PDFKit protection service is unavailable.', 503);
  const body = await readJson(request, protectionBodyLimit);
  const protection = body?.protection;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3
    || Object.keys(body).some((key) => !['profile', 'sourceSha256', 'protection'].includes(key)) || body.profile !== 'macos-pdfkit-aes128-v1'
    || !isLowercaseSha256(body.sourceSha256) || !protection || typeof protection !== 'object' || Array.isArray(protection)
    || Object.keys(protection).length !== 3 || Object.keys(protection).some((key) => !['permissionsProfile', 'ownerPassword', 'userPassword'].includes(key))
    || typeof protection.permissionsProfile !== 'string' || typeof protection.ownerPassword !== 'string' || typeof protection.userPassword !== 'string') {
    throw new HostError('INVALID_PDFKIT_PROTECTION_OPTIONS', 'PDFKit protection requires the fixed profile, source digest, and exact password fields.', 400);
  }
  const result = await pdfkitProtection.protect(documentId, protection, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return;
  json(response, 201, { result });
}

export async function handlePdfkitSanitization(context) {
  const { request, response, url, documentId, processing, store, pdfkitSanitization, protectionBodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  rejectQueryParameters(url, 'Metadata sanitization does not accept query parameters.');
  if (!pdfkitSanitization) throw new HostError('PDFKIT_SANITIZATION_UNAVAILABLE', 'The pinned local macOS PDFKit metadata-sanitization service is unavailable.', 503);
  const body = await readJson(request, protectionBodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256']) || body.profile !== 'macos-pdfkit-metadata-sanitize-v1' || !isLowercaseSha256(body.sourceSha256)) {
    throw new HostError('INVALID_PDFKIT_SANITIZATION_OPTIONS', 'Metadata sanitization requires exactly the fixed profile and current lowercase source SHA-256.', 400);
  }
  const result = await pdfkitSanitization.sanitizeMetadata(documentId, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return;
  json(response, 201, { result });
}

export async function handlePdfkitProtectionRemoval(context) {
  const { request, response, url, documentId, processing, store, pdfkitProtection, protectionBodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  rejectQueryParameters(url, 'PDFKit protection removal does not accept query parameters.');
  if (!pdfkitProtection) throw new HostError('PDFKIT_PROTECTION_REMOVAL_UNAVAILABLE', 'The pinned local macOS PDFKit protection-removal service is unavailable.', 503);
  const body = await readJson(request, protectionBodyLimit);
  const removal = body?.removal;
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'removal']) || body.profile !== 'macos-pdfkit-remove-protection-v1'
    || !isLowercaseSha256(body.sourceSha256) || !exactJsonObject(removal, ['artifactId', 'artifactSha256', 'ownerPassword'])
    || typeof removal.artifactId !== 'string' || typeof removal.artifactSha256 !== 'string' || typeof removal.ownerPassword !== 'string') {
    throw new HostError('INVALID_PDFKIT_PROTECTION_REMOVAL_OPTIONS', 'PDFKit protection removal requires the fixed profile, source digest, retained artifact binding, and owner credential.', 400);
  }
  const result = await pdfkitProtection.removeProtection(documentId, removal, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return;
  json(response, 201, { result });
}
