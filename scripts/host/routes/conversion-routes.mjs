import { HostError } from '../host-error.mjs';

const WORKSPACE_JSON_BODY_LIMIT = 768 * 1024;

export async function handleConversionRoute(context) {
  const {
    pathname, request, response, url, processing, store, inputs, conversion,
    method, json, empty, readJson, requireContentType, decodeDisplayName,
  } = context;
  if (pathname === '/api/documents/create-blank') {
    if (!conversion) throw new HostError('CONVERSION_UNAVAILABLE', 'Local document creation is unavailable.', 503);
    method(request, 'POST');
    const document = await conversion.createBlank(await readJson(request));
    json(response, 201, { document });
    return true;
  }
  if (pathname === '/api/documents/create-text') {
    if (!conversion) throw new HostError('CONVERSION_UNAVAILABLE', 'Local document creation is unavailable.', 503);
    method(request, 'POST');
    const document = await conversion.createText(await readJson(request, WORKSPACE_JSON_BODY_LIMIT));
    json(response, 201, { document });
    return true;
  }
  if (pathname === '/api/inputs') {
    if (!inputs) throw new HostError('CONVERSION_UNAVAILABLE', 'Local input conversion is unavailable.', 503);
    method(request, 'POST');
    const mediaType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!mediaType) throw new HostError('UNSUPPORTED_MEDIA_TYPE', 'A conversion input media type is required.', 415);
    const input = await inputs.createInput({ stream: request, displayName: decodeDisplayName(request), mediaType });
    json(response, 201, { input });
    return true;
  }
  const inputMatch = pathname.match(/^\/api\/inputs\/([^/]+)(?:\/(convert))?$/);
  if (inputMatch) {
    if (!inputs || !conversion) throw new HostError('CONVERSION_UNAVAILABLE', 'Local input conversion is unavailable.', 503);
    const [, inputId, operation] = inputMatch;
    if (operation === 'convert') {
      method(request, 'POST');
      json(response, 201, { document: await conversion.convertInput(inputId, processing) });
      return true;
    }
    if (request.method === 'GET') {
      json(response, 200, { input: inputs.getInput(inputId) });
      return true;
    }
    if (request.method === 'DELETE') {
      await inputs.deleteInput(inputId);
      empty(response);
      return true;
    }
    throw new HostError('METHOD_NOT_ALLOWED', 'Input assets support GET and DELETE.', 405);
  }
  if (pathname !== '/api/documents') return false;
  method(request, 'POST');
  requireContentType(request, 'application/pdf');
  const document = await store.createDocument({
    stream: request, displayName: decodeDisplayName(request), mediaType: 'application/pdf',
  });
  json(response, 201, { document });
  return true;
}
