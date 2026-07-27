import { HostError } from '../host-error.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function exact(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
}
function exactArray(value, maximum = 500) {
  return Array.isArray(value) && value.length >= 1 && value.length <= maximum
    && Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).length === value.length
    && Object.getOwnPropertyDescriptor(value, 'length')?.enumerable === false
    && Object.keys(Object.getOwnPropertyDescriptors(value)).filter((key) => key !== 'length').every((key) => Object.getOwnPropertyDescriptor(value, key).enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

export async function handleAecMeasurementLegendRoute({ request, response, url, documentId, operation, processing, store, workspaceState, aecMeasurementLegend, method, readJson, json }) {
  if (operation !== 'aec-measurement-legend') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'AEC measurement legend does not accept query parameters.', 400);
  if (!aecMeasurementLegend || !workspaceState) throw new HostError('AEC_LEGEND_UNAVAILABLE', 'AEC measurement legend generation is unavailable.', 503);
  const body = await readJson(request, 8_192);
  if (!exact(body, ['sourceSha256', 'expectedRevision', 'measurementIds']) || !SHA256.test(body.sourceSha256 ?? '') || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || body.expectedRevision > 1_000_000 || !exactArray(body.measurementIds) || body.measurementIds.some((id) => typeof id !== 'string' || !ID.test(id))) throw new HostError('INVALID_AEC_LEGEND_OPTIONS', 'The AEC measurement legend request is invalid.', 400);
  const document = store.getDocument(documentId); if (document.sha256 !== body.sourceSha256) throw new HostError('SOURCE_VERSION_MISMATCH', 'AEC legend source digest does not match the current document.', 409);
  const state = workspaceState.snapshot(documentId); if (state.revision !== body.expectedRevision) throw new HostError('REVISION_CONFLICT', 'AEC legend workspace revision is stale.', 409);
  const ids = new Set(); const records = body.measurementIds.map((measurementId) => {
    if (ids.has(measurementId)) throw new HostError('INVALID_AEC_LEGEND_OPTIONS', 'AEC legend measurement IDs must be unique.', 400); ids.add(measurementId);
    const measurement = state.namespaces.measurements.find((record) => record?.id === measurementId && record?.schemaVersion === 2 && record?.type === 'measurement');
    if (!measurement) throw new HostError('AEC_MEASUREMENT_NOT_FOUND', 'A source-bound AEC measurement record was not found.', 404);
    const page = measurement.source?.page; const sheetId = measurement.sheetId ?? `page-${page}`; const toolId = measurement.toolId ?? `aec-${measurement.kind}`; const styleId = measurement.styleId ?? 'default';
    if (!Number.isSafeInteger(page) || !ID.test(sheetId) || !ID.test(toolId) || !ID.test(styleId)) throw new HostError('AEC_LEGEND_RECORD_INVALID', 'The trusted AEC measurement record lacks bounded legend metadata.', 422);
    return { sheetId, page, revision: state.revision, toolId, styleId, measurement: { kind: 'source-bound-aec-measurement', schemaVersion: 1, sourceDigest: document.sha256, workspaceRevision: state.revision, measurement } };
  });
  const result = aecMeasurementLegend.generate({ sourceSha256: body.sourceSha256, expectedRevision: state.revision, records }, { signal: processing.signal });
  json(response, 200, { result }); return true;
}
