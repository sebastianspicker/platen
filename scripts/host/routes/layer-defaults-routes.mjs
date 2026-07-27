import { HostError } from '../host-error.mjs';
import { PDF_LAYER_DEFAULTS_PROFILE, normalizePdfLayerDefaults } from '../pdf-layer-defaults-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

export async function handleLayerDefaultsRoute(context) {
  if (context.operation !== 'layer-defaults') return false;
  const { request, response, url, documentId, processing, layerDefaults, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Layer-defaults editing does not accept query parameters.', 400);
  if (!layerDefaults) throw new HostError('PDF_LAYER_DEFAULTS_UNAVAILABLE', 'The local layer-defaults service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'changes'])
    || body.profile !== PDF_LAYER_DEFAULTS_PROFILE
    || typeof body.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(body.sourceSha256)) {
    throw new HostError('INVALID_PDF_LAYER_DEFAULTS_OPTIONS', 'Layer-defaults editing requires the fixed profile, current lowercase source SHA-256, and ordered visibility changes.', 400);
  }
  let normalized;
  try { normalized = normalizePdfLayerDefaults(body); } catch (error) {
    throw new HostError('INVALID_PDF_LAYER_DEFAULTS_OPTIONS', 'Layer-defaults editing requires ordered group visibility changes.', 400, { cause: error });
  }
  const result = await layerDefaults.update(documentId, normalized, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
