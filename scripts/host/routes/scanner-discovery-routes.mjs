import { HostError } from '../host-error.mjs';

export async function handleScannerDiscoveryRoute({ pathname, request, response, url, processing, scannerDiscovery, scannerDiscoveryReady, method, readJson, json, exactJsonObject }) {
  if (pathname !== '/api/scanners/discover') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Scanner discovery does not accept query parameters.', 400);
  if (!scannerDiscoveryReady || !scannerDiscovery) throw new HostError('SCANNER_DISCOVERY_UNAVAILABLE', 'The scanner discovery helper is unavailable.', 503);
  const body = await readJson(request, 256);
  if (!exactJsonObject(body, []) || Reflect.ownKeys(body).length !== 0) throw new HostError('INVALID_SCANNER_DISCOVERY_REQUEST', 'Scanner discovery requires an empty JSON object.', 400);
  try {
    const result = await scannerDiscovery.discover({ signal: processing.signal });
    json(response, 200, result);
  } catch (error) {
    if (processing.signal.aborted || error?.code === 'ENGINE_CANCELLED') throw new HostError('JOB_CANCELLED', 'Scanner discovery was cancelled.', 499, { cause: error });
    throw new HostError('SCANNER_DISCOVERY_FAILED', 'The scanner discovery helper failed its bounded contract.', 502, { cause: error });
  }
  return true;
}
