import { HostError } from '../host-error.mjs';

const ASSET_METHODS = {
  fonts: 'listFonts', images: 'listImages', attachments: 'listAttachments', signatures: 'verifySignatures',
};

export async function handleDocumentReadRoute(context) {
  const { operation } = context;
  if (operation === 'source') return sendSource(context);
  if (operation === 'inspection') return sendInspection(context);
  if (operation === 'structure') return sendStructure(context);
  if (operation === 'text') return sendText(context);
  if (operation === 'thumbnail') return sendThumbnail(context);
  if (operation === 'cropbox-raster') return sendCropBoxRaster(context);
  if (operation === 'cropbox-snapshot') return sendCropBoxSnapshot(context);
  if (!Object.hasOwn(ASSET_METHODS, operation)) return false;
  return sendAssets(context);
}

function sendSource({ request, response, documentId, store, method, sendArtifact }) {
  method(request, 'GET');
  const document = store.getDocument(documentId);
  sendArtifact(response, { ...document, filePath: store.getSourcePath(documentId) });
}

async function sendInspection({ request, response, documentId, processing, service, method, json }) {
  method(request, 'GET');
  json(response, 200, { inspection: await service.inspect(documentId, processing) });
}

async function sendStructure({ request, response, url, documentId, processing, service, method, json, parsePositiveInteger }) {
  method(request, 'GET');
  const firstPage = parsePositiveInteger(url.searchParams.get('first') ?? '1', 'first', { maximum: 1_000_000 });
  const lastValue = url.searchParams.get('last');
  const includeTagTextValue = url.searchParams.get('includeTagText') ?? 'false';
  if (!['true', 'false'].includes(includeTagTextValue)) throw new HostError('INVALID_PARAMETER', 'includeTagText must be true or false.', 400);
  const structure = await service.inspectStructure(documentId, {
    firstPage, lastPage: lastValue === null ? null : parsePositiveInteger(lastValue, 'last', { maximum: 1_000_000 }),
    includeTagText: includeTagTextValue === 'true', ...processing,
  });
  json(response, 200, { structure });
}

async function sendText({ request, response, url, documentId, processing, service, method, json, parsePositiveInteger }) {
  method(request, 'GET');
  const pageCountValue = url.searchParams.get('pages');
  const pageCount = pageCountValue === null ? null : parsePositiveInteger(pageCountValue, 'pages');
  json(response, 200, { pages: await service.extractText(documentId, pageCount, processing) });
}

async function sendThumbnail({ request, response, url, documentId, processing, service, method, write, parsePositiveInteger }) {
  method(request, 'GET');
  const page = parsePositiveInteger(url.searchParams.get('page'), 'page');
  const dpi = parsePositiveInteger(url.searchParams.get('dpi') ?? '96', 'dpi', { minimum: 36, maximum: 240 });
  write(response, 200, await service.renderThumbnail(documentId, { page, dpi, ...processing }), 'image/png');
}

async function sendCropBoxRaster({ request, response, url, documentId, processing, service, method, write, parsePositiveInteger }) {
  method(request, 'GET');
  if (url.searchParams.size !== 2 || !url.searchParams.has('page') || !url.searchParams.has('dpi')) throw new HostError('INVALID_PARAMETER', 'CropBox raster rendering requires only page and dpi query parameters.', 400);
  const page = parsePositiveInteger(url.searchParams.get('page'), 'page');
  const dpi = parsePositiveInteger(url.searchParams.get('dpi'), 'dpi', { minimum: 36, maximum: 240 });
  write(response, 200, await service.renderCropBoxPage(documentId, { page, dpi, ...processing }), 'image/png');
}

async function sendCropBoxSnapshot({ request, response, url, documentId, processing, service, method, write, parsePositiveInteger, parseSnapshotRegion }) {
  method(request, 'GET');
  const region = parseSnapshotRegion(url.searchParams);
  const page = parsePositiveInteger(url.searchParams.get('page'), 'page');
  const dpi = parsePositiveInteger(url.searchParams.get('dpi'), 'dpi', { minimum: 36, maximum: 240 });
  write(response, 200, await service.renderCropBoxSnapshot(documentId, { page, dpi, region, ...processing }), 'image/png');
}

async function sendAssets({ request, response, documentId, operation, processing, service, method, json }) {
  method(request, 'GET');
  const assetMethod = ASSET_METHODS[operation];
  json(response, 200, { [operation === 'signatures' ? 'signatures' : operation]: await service[assetMethod](documentId, processing) });
}
