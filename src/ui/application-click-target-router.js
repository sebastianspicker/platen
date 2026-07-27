import { pageNumberFromNavigationTarget } from '../core/ui-actions.js';

export async function routeApplicationClickTarget({
  event,
  state,
  controllers,
  render,
}) {
  const pageElement = event.target.closest('[data-page-number]');
  const rewriteElement = event.target.closest('[data-rewrite-mode]');
  const rasterElement = event.target.closest('[data-raster-operation]');
  const domainElement = event.target.closest('[data-domain-operation]');
  const row = event.target.closest('[data-plugin-row]');
  const family = event.target.closest('[data-family]');

  if (pageElement) {
    const page = pageNumberFromNavigationTarget(
      pageElement,
      state.analysis?.inspection?.pageCount,
    );
    if (page !== null) controllers.viewer.selectPage(page);
    return true;
  }
  if (row) {
    state.selectedPlugin = row.dataset.pluginRow;
    render();
    return true;
  }
  if (family) {
    state.familyFilter = family.dataset.family;
    state.selectedPlugin = '';
    render();
    return true;
  }
  if (rewriteElement) {
    await controllers.generation.rewriteLocalDocument(rewriteElement.dataset.rewriteMode);
    return true;
  }
  if (rasterElement) {
    await controllers.raster.runRasterMutation(rasterElement.dataset.rasterOperation);
    return true;
  }
  if (domainElement) {
    controllers.domain.selectDomainOperation(
      domainElement.dataset.domainGroup,
      domainElement.dataset.domainOperation,
    );
    return true;
  }
  return false;
}
