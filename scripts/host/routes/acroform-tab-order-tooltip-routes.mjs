import { HostError } from '../host-error.mjs';
import { PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE } from '../pdf-acroform-tab-order-tooltip-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const BODY_LIMIT = 2_048;

function validTooltip(value) {
  return typeof value === 'string' && value === value.normalize('NFC')
    && [...value].length >= 1 && [...value].length <= 127
    && Buffer.byteLength(value, 'utf8') <= 512
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value);
}

function validBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.getPrototypeOf(body) !== Object.prototype
    || Object.keys(body).length !== 4
    || Object.keys(body).some((key) => !['profile', 'sourceSha256', 'target', 'tooltip'].includes(key))) return false;
  const target = body.target;
  return body.profile === PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE
    && SHA256.test(body.sourceSha256 ?? '') && validTooltip(body.tooltip)
    && target && typeof target === 'object' && !Array.isArray(target)
    && Object.getPrototypeOf(target) === Object.prototype
    && Object.keys(target).length === 3
    && Object.keys(target).every((key) => ['page', 'annotationIndex', 'fingerprint'].includes(key))
    && Number.isSafeInteger(target.page) && target.page >= 1 && target.page <= 10_000
    && Number.isSafeInteger(target.annotationIndex) && target.annotationIndex >= 0 && target.annotationIndex < 50
    && FINGERPRINT.test(target.fingerprint ?? '');
}

export async function handleAcroFormTabOrderTooltipRoute(context) {
  const { request, response, url, documentId, operation, processing, store,
    acroFormTabOrderTooltip, method, readJson, json } = context;
  if (operation !== 'acroform-tab-order-tooltip') return false;
  method(request, 'POST');
  if (url.search !== '') throw new HostError('INVALID_ACROFORM_TAB_ORDER_TOOLTIP_REQUEST', 'Tab-order tooltip updates do not accept query parameters.', 400);
  if (!acroFormTabOrderTooltip) throw new HostError('ACROFORM_TAB_ORDER_TOOLTIP_UNAVAILABLE', 'Tab-order tooltip updates are unavailable.', 503);
  const body = await readJson(request, BODY_LIMIT);
  if (!validBody(body)) throw new HostError('INVALID_ACROFORM_TAB_ORDER_TOOLTIP_REQUEST', 'The tab-order tooltip request is invalid.', 400);
  const result = await acroFormTabOrderTooltip.update(documentId, body, { signal: processing.signal });
  if (result.proof?.sourceSha256 !== body.sourceSha256 || result.artifact?.documentId !== documentId) {
    if (typeof result.artifact?.id === 'string') await store.deleteArtifact(result.artifact.id);
    throw new HostError('ACROFORM_TAB_ORDER_TOOLTIP_RESULT_INVALID', 'Tab-order tooltip evidence does not match the requested source.', 502);
  }
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
