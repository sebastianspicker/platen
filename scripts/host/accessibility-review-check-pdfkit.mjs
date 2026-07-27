import { HostError } from './host-error.mjs';

function countOutlineItems(items, depth = 0) {
  if (!Array.isArray(items) || depth >= 8) return 0;
  return items.slice(0, 200).reduce(
    (total, item) => total + 1 + countOutlineItems(item?.children, depth + 1),
    0,
  );
}

export function summarizePdfKit(result, document) {
  if (!result) return Object.freeze({ available: false });
  if (
    result.sourceDigest !== document.sha256
    || result.pageCount !== document.pageCount
    || !result.document
    || !Array.isArray(result.pages)
  ) {
    throw new HostError(
      'INVALID_ENGINE_OUTPUT',
      'Optional PDFKit accessibility evidence is not bound to the immutable source.',
      502,
    );
  }
  const widgets = result.pages.flatMap((page) => (
    Array.isArray(page?.widgets) ? page.widgets : []
  ));
  const permissions = result.document.permissions;
  return Object.freeze({
    available: true,
    contentAccessibility: typeof permissions?.contentAccessibility === 'boolean'
      ? permissions.contentAccessibility
      : null,
    permissionStatus: ['none', 'user', 'owner', 'unknown'].includes(permissions?.status)
      ? permissions.status
      : 'unknown',
    widgetCount: widgets.length,
    unnamedWidgetCount: widgets.filter((widget) => !String(widget?.fieldName ?? '').trim()).length,
    widgetsTruncated: result.pagesTruncated === true
      || result.pages.some((page) => page?.widgetsTruncated === true),
    outlineItemCount: countOutlineItems(result.outline?.items),
    outlineTruncated: result.outline?.truncated === true,
  });
}
