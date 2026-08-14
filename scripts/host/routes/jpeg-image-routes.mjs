import { HostError } from '../host-error.mjs';
import { PDF_JPEG_IMAGE_PROFILE } from '../pdf-jpeg-image-writer.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

export async function handleJpegImageRoute({ request, response, url, documentId, operation, processing, store, jpegImage, jpegImageReady, bodyLimit, exactJsonObject, method, readJson, json }) {
  if (operation !== 'insert-jpeg') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'JPEG image insertion does not accept query parameters.', 400);
  if (!jpegImageReady || !jpegImage) throw new HostError('PDF_JPEG_IMAGE_UNAVAILABLE', 'JPEG image insertion is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  const keys = ['profile', 'sourceSha256', 'inputId', 'inputSha256', 'page', 'rect'];
  if (!exactJsonObject(body, keys) || body.profile !== PDF_JPEG_IMAGE_PROFILE) throw new HostError('INVALID_PDF_JPEG_IMAGE_OPTIONS', 'JPEG image insertion requires the fixed profile and explicit source and input digests.', 400);
  const result = await jpegImage.insert(documentId, body, { signal: processing.signal });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
