import { HostError } from '../host-error.mjs';

const PAGE_OPERATION_METHODS = { extract: 'extractPages', arrange: 'arrangePages', duplicate: 'duplicatePages' };
const SECONDARY_OPERATION_ERRORS = {
  merge: ['INVALID_MERGE', 'A secondary local document identifier is required.'],
  interleave: ['INVALID_INTERLEAVE', 'A secondary local document identifier is required.'],
  insert: ['INVALID_INSERT', 'A secondary local document identifier is required.'],
  replace: ['INVALID_REPLACE', 'A replacement local document identifier is required.'],
};

export async function handleDocumentMutationRoute(context) {
  const { operation } = context;
  if (PAGE_OPERATION_METHODS[operation]) return mutatePages(context);
  if (operation === 'split') return splitDocument(context);
  if (operation === 'split-rule') return splitDocumentByRule(context);
  if (operation === 'reverse') return reverseDocument(context);
  return combineDocuments(context);
}

async function mutatePages({ request, response, documentId, operation, processing, service, method, readJson, json }) {
  method(request, 'POST');
  const body = await readJson(request);
  json(response, 201, { artifact: await service[PAGE_OPERATION_METHODS[operation]](documentId, body.pages, processing) });
}

async function splitDocument({ request, response, documentId, processing, service, method, json }) {
  method(request, 'POST');
  json(response, 201, { artifacts: await service.splitDocument(documentId, processing) });
}

async function splitDocumentByRule({ request, response, documentId, processing, service, method, readJson, json, parsePositiveInteger }) {
  method(request, 'POST');
  const body = await readJson(request);
  const pagesPerOutput = parsePositiveInteger(body.pagesPerOutput, 'pagesPerOutput', { maximum: 500 });
  json(response, 201, { artifacts: await service.splitByPageCount(documentId, pagesPerOutput, processing) });
}

async function reverseDocument({ request, response, documentId, processing, service, method, json }) {
  method(request, 'POST');
  json(response, 201, { artifact: await service.reversePages(documentId, processing) });
}

async function combineDocuments(context) {
  const { request, response, documentId, operation, processing, service, method, readJson, json, parsePositiveInteger } = context;
  method(request, 'POST');
  const body = await readJson(request);
  if (typeof body.secondaryDocumentId !== 'string') throw new HostError(...SECONDARY_OPERATION_ERRORS[operation], 400);
  if (operation === 'merge') return json(response, 201, { artifact: await service.mergeDocuments(documentId, body.secondaryDocumentId, processing) });
  if (operation === 'interleave') return json(response, 201, { artifact: await service.interleaveDocuments(documentId, body.secondaryDocumentId, processing) });
  if (operation === 'insert') {
    const afterPage = parsePositiveInteger(body.afterPage, 'afterPage', { minimum: 0, maximum: 1_000_000 });
    return json(response, 201, { artifact: await service.insertDocument(documentId, body.secondaryDocumentId, afterPage, processing) });
  }
  const startPage = parsePositiveInteger(body.startPage, 'startPage');
  const endPage = parsePositiveInteger(body.endPage, 'endPage');
  return json(response, 201, { artifact: await service.replacePages(documentId, body.secondaryDocumentId, startPage, endPage, processing) });
}
